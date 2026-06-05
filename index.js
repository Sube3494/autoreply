const fs = require('fs');
const path = require('path');

// 载入配置
const configPath = path.join(__dirname, 'config.json');
let config = {
  chromeDebugUrl: "http://127.0.0.1:9222",
  pollIntervalMs: 3000,
  defaultReply: "您好！已收到您的消息，小店客服正在为您处理，请稍等片刻~",
  keywords: {}
};

if (fs.existsSync(configPath)) {
  try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    console.log("[INIT] 成功载入配置文件 config.json");
  } catch (e) {
    console.error("[INIT] 载入 config.json 失败，将使用默认配置。错误:", e.message);
  }
}

// 内存中维护的已回复顾客集合，用于防重复回复
const repliedCustomers = new Set();

// 存储当前所有活动标签页连接的 Map: pageId -> { ws, title, url }
const activeConnections = new Map();

// 周期同步标签页列表的定时器
let syncPagesTimer = null;

// 主运行入口
async function main() {
  console.log("[INIT] 京东秒送多店铺自动回复主服务已启动。");
  console.log("[INIT] 开始每 5 秒自动检测并同步浏览器标签页...");
  
  // 立即同步一次，并建立 5 秒轮询同步标签页
  syncPages();
  syncPagesTimer = setInterval(syncPages, 5000);
}

// 同步浏览器标签页状态，动态支持多店铺 Tab 页面的打开与关闭
async function syncPages() {
  try {
    const res = await fetch(`${config.chromeDebugUrl}/json`);
    if (!res.ok) throw new Error(`HTTP 状态异常: ${res.status}`);
    const pagesList = await res.json();
    
    // 过滤出所有京东客服活动页面（包含 imSettings 或 store.jddj.com）
    const targetPages = pagesList.filter(p => 
      p.type === 'page' && 
      (p.url.includes('imSettings') || p.url.includes('store.jddj.com'))
    );
    
    const targetPageIds = new Set(targetPages.map(p => p.id));
    
    // 1. 清理已经被用户关闭的标签页连接
    for (const [id, conn] of activeConnections.entries()) {
      if (!targetPageIds.has(id)) {
        console.log(`[DISCONNECT] 标签页已关闭或失效，正在断开连接: ${conn.title} (${conn.url})`);
        try { conn.ws.close(); } catch (e) {}
        activeConnections.delete(id);
      }
    }
    
    // 2. 建立新标签页的连接
    for (const pageInfo of targetPages) {
      if (!activeConnections.has(pageInfo.id)) {
        connectToPage(pageInfo);
      }
    }
    
  } catch (err) {
    console.error("[ERROR] 同步标签页失败，请确保 Chrome 9222 调试端口已开启且无网络阻塞。错误:", err.message);
    
    // 自我诊断：如果连接不上调试端口，自动读取并输出 Chrome 启动日志
    const logPath = '/app/chrome_start.log';
    if (fs.existsSync(logPath)) {
      try {
        const chromeLog = fs.readFileSync(logPath, 'utf8');
        console.error("----------------------------------------------------------------");
        console.error("[DIAGNOSE] 自动诊断：检测到 Chrome 启动错误日志，具体内容如下:");
        console.error(chromeLog);
        console.error("----------------------------------------------------------------");
      } catch (e) {
        console.error("[DIAGNOSE] 读取 Chrome 日志失败:", e.message);
      }
    }
    
    for (const [id, conn] of activeConnections.entries()) {
      try { conn.ws.close(); } catch (e) {}
    }
    activeConnections.clear();
  }
}

// 连接单个标签页并启动其专属监测循环
function connectToPage(pageInfo) {
  // 临时防止重复连接
  activeConnections.set(pageInfo.id, { ws: null, title: pageInfo.title, url: pageInfo.url });
  
  console.log(`[CONNECT] 正在连接新店铺标签页: "${pageInfo.title}" -> ${pageInfo.url}`);
  const ws = new WebSocket(pageInfo.webSocketDebuggerUrl);
  
  ws.onopen = () => {
    // 放入活动 Map 中
    activeConnections.set(pageInfo.id, { ws, title: pageInfo.title, url: pageInfo.url });
    console.log(`[SUCCESS] 成功接入店铺 "${pageInfo.title}" 监测线程。`);
    
    // 启动该页面的专属自动回复监测循环
    runMonitoringLoopForPage(pageInfo.id);
  };
  
  ws.onerror = (err) => {
    console.error(`[ERROR] 店铺 "${pageInfo.title}" 连接异常:`, err.message);
  };
  
  ws.onclose = () => {
    if (activeConnections.has(pageInfo.id) && activeConnections.get(pageInfo.id).ws !== null) {
      console.log(`[DISCONNECT] 店铺 "${pageInfo.title}" 连接断开。`);
    }
    activeConnections.delete(pageInfo.id);
  };
}

// 发送指令给特定页面的封装
function evaluateInBrowser(ws, expression) {
  return new Promise((resolve, reject) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return reject(new Error("WebSocket 未连接或已关闭"));
    }
    
    const id = Date.now() + Math.floor(Math.random() * 1000);
    const payload = JSON.stringify({
      id,
      method: "Runtime.evaluate",
      params: {
        expression,
        awaitPromise: true,
        returnByValue: true
      }
    });
    
    const handleMessage = (event) => {
      const response = JSON.parse(event.data);
      if (response.id === id) {
        ws.removeEventListener('message', handleMessage);
        if (response.error) {
          reject(response.error);
        } else if (response.result && response.result.result) {
          resolve(response.result.result.value);
        } else {
          resolve(null);
        }
      }
    };
    
    ws.addEventListener('message', handleMessage);
    ws.send(payload);
  });
}

// 针对单店铺页面的专属监测循环
async function runMonitoringLoopForPage(pageId) {
  let loopCount = 0;
  
  while (true) {
    const conn = activeConnections.get(pageId);
    if (!conn || !conn.ws || conn.ws.readyState !== WebSocket.OPEN) {
      break;
    }
    
    const shopLabel = `[店铺: ${conn.title.substring(0, 15)}]`;
    loopCount++;
    
    try {
      // 1. 在浏览器内部执行监测逻辑
      const result = await evaluateInBrowser(conn.ws, `(async () => {
        try {
          let shopName = "";
          const shopHeader = document.querySelector('.im-dashboard-container, [class*=\"dashboard\"]');
          if (shopHeader) {
            const headerText = shopHeader.innerText || "";
            shopName = headerText.split('\\n')[0] || "";
          }
          
          // 确保勾选“只看未读”复选框
          const unreadLabel = Array.from(document.querySelectorAll('*'))
            .find(el => (el.innerText || '').trim() === '只看未读');
          if (unreadLabel) {
            const parent = unreadLabel.parentElement;
            const checkbox = parent ? parent.querySelector('input[type=\"checkbox\"]') : null;
            if (checkbox && !checkbox.checked) {
              checkbox.click();
              await new Promise(r => setTimeout(r, 1000));
            }
          }
          
          // 获取当前未回复的顾客列表
          const customerItems = Array.from(document.querySelectorAll('.sc-ipUnzB, [class*=\"customer-item\"]'));
          const unreadCount = customerItems.length;
          
          if (unreadCount === 0) {
            return { hasUnread: false, unreadCount: 0, shopName };
          }
          
          // 提取第一个顾客昵称
          const firstCustomer = customerItems[0];
          const name = firstCustomer.innerText.replace(/\\n/g, ' ').split(' ')[0] || firstCustomer.innerText.replace(/\\n/g, ' ');
          
          // 点击加载会话
          firstCustomer.click();
          await new Promise(r => setTimeout(r, 1500));
          
          // 检测是否已经有过客服回复记录
          const chatContainer = document.querySelector('.sc-CZWsc') || document.body;
          const chatText = chatContainer ? chatContainer.innerText : '';
          const hasRepliedBefore = chatText.includes('客服') || 
                                   chatText.includes('店小二') ||
                                   chatText.includes('自动回复') ||
                                   chatText.includes('收到您的消息');
          
          // 获取最近顾客发送的内容
          let latestText = "";
          const bubbleContainers = Array.from(document.querySelectorAll('.sc-CZWsc div[class*=\"bubble\"], [class*=\"msg-content\"]'));
          if (bubbleContainers.length > 0) {
            latestText = bubbleContainers[bubbleContainers.length - 1].innerText || "";
          }
          
          return {
            hasUnread: true,
            unreadCount,
            shopName: shopName || name,
            customerName: name,
            latestText: latestText.substring(0, 100).trim(),
            hasRepliedBefore
          };
          
        } catch (e) {
          return { success: false, error: e.message };
        }
      })()`);
      
      // 每 10 次轮询（约 30 秒）输出一次运行心跳，供用户确认状态并诊断选择器
      if (loopCount >= 10) {
        loopCount = 0;
        const unreadCount = result ? (result.unreadCount || 0) : 0;
        const displayShop = (result && result.shopName) ? `[${result.shopName}]` : shopLabel;
        console.log(`[HEARTBEAT] ${displayShop} 自动回复监测运行中。当前排队未读顾客数: ${unreadCount}`);
      }
      
      if (result && result.hasUnread) {
        const customerKey = result.customerName.trim();
        const displayShop = result.shopName ? `[${result.shopName}]` : shopLabel;
        
        // 判定是否是本标签页首次咨询
        if (repliedCustomers.has(customerKey) || result.hasRepliedBefore) {
          if (!repliedCustomers.has(customerKey)) {
            repliedCustomers.add(customerKey);
          }
        } else {
          console.log(`\n${displayShop} [ALERT] 监测到新咨询顾客: "${customerKey}"`);
          console.log(`${displayShop} [INFO] 顾客消息: "${result.latestText || '（非文本消息）'}"`);
          
          // 决策回复内容
          let replyContent = config.defaultReply;
          if (result.latestText) {
            for (const key in config.keywords) {
              if (result.latestText.includes(key)) {
                replyContent = config.keywords[key];
                console.log(`${displayShop} [MATCH] 匹配到关键词 "${key}"，启用专用回复语。`);
                break;
              }
            }
          }
          
          console.log(`${displayShop} [ACTION] 正在发送自动回复: "${replyContent}"`);
          
          // 执行自动发送
          const sendResult = await evaluateInBrowser(conn.ws, `(async () => {
            try {
              let editor = document.querySelector('.ql-editor') || 
                           document.querySelector('[contenteditable=\"true\"]') ||
                           document.querySelector('textarea');
                           
              if (!editor) return { success: false, error: "输入框不存在" };
              
              const isEditable = editor.contentEditable === 'true' || editor.getAttribute('contenteditable') === 'true';
              editor.focus();
              
              const textToSend = ${JSON.stringify(replyContent)};
              
              if (isEditable) {
                editor.innerHTML = textToSend;
                editor.dispatchEvent(new Event('input', { bubbles: true }));
                
                try {
                  const range = document.createRange();
                  range.selectNodeContents(editor);
                  range.collapse(false);
                  const sel = window.getSelection();
                  sel.removeAllRanges();
                  sel.addRange(range);
                  document.execCommand('insertText', false, textToSend);
                } catch (e) {}
              } else {
                editor.value = textToSend;
                editor.dispatchEvent(new Event('input', { bubbles: true }));
              }
              
              await new Promise(r => setTimeout(r, 500));
              
              const sendBtn = Array.from(document.querySelectorAll('button, div, span'))
                .find(el => (el.innerText || '').trim() === '发送' && el.tagName !== 'SPAN');
                
              if (!sendBtn) return { success: false, error: "发送按钮缺失" };
              
              sendBtn.click();
              return { success: true };
            } catch (e) {
              return { success: false, error: e.message };
            }
          })()`);
          
          if (sendResult && sendResult.success) {
            console.log(`${displayShop} [SUCCESS] 回复发送成功！`);
            repliedCustomers.add(customerKey);
            await new Promise(r => setTimeout(r, 3000)); // 成功后延时同步
          } else {
            console.error(`${displayShop} [ERROR] 回复发送失败: ${sendResult ? sendResult.error : '未知错误'}`);
          }
        }
      }
      
    } catch (err) {
      console.error(`${shopLabel} [ERROR] 轮询异常:`, err.message);
      if (err.message.includes("WebSocket") || err.message.includes("关闭")) {
        break; // 断开，退出此循环，同步模块会负责重连
      }
    }
    
    await new Promise(r => setTimeout(r, config.pollIntervalMs));
  }
}

// 启动服务
main();
