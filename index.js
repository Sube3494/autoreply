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
    
    // 过滤出所有京东客服活动页面（包含 imSettings，或者包含 store.jddj.com 且属于 notify 或 frame 路径）
    const targetPages = pagesList.filter(p => 
      p.type === 'page' && 
      (
        p.url.includes('imSettings') || 
        p.url.includes('store.jddj.com/notify/') || 
        p.url.includes('store.jddj.com/frame/')
      )
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
    
    // 2. 建立新标签页 the 连接
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
  activeConnections.set(pageInfo.id, { ws: null, title: pageInfo.title, url: pageInfo.url });
  
  console.log(`[CONNECT] 正在连接新店铺标签页: "${pageInfo.title}" -> ${pageInfo.url}`);
  const ws = new WebSocket(pageInfo.webSocketDebuggerUrl);
  
  ws.onopen = () => {
    activeConnections.set(pageInfo.id, { ws, title: pageInfo.title, url: pageInfo.url });
    console.log(`[SUCCESS] 成功接入店铺 "${pageInfo.title}" 监测线程。`);
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

// 发送指令给特定页面的封装（包含 5 秒超时保护，防止 CDP 无响应卡死）
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
        awaitPromise: false, // 优化：更改为同步非阻塞式立即求值，不等待悬空 Promise
        returnByValue: true
      }
    });
    
    const timeoutId = setTimeout(() => {
      ws.removeEventListener('message', handleMessage);
      reject(new Error("浏览器 CDP 执行超时(5000ms)"));
    }, 5000);
    
    const handleMessage = (event) => {
      const response = JSON.parse(event.data);
      if (response.id === id) {
        clearTimeout(timeoutId);
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
      // 优化：重构为纯同步、“非阻塞式状态机”，剔除了 evaluate 内部的 sleep 延时，执行时长小于 5 毫秒
      const result = await evaluateInBrowser(conn.ws, `(() => {
        try {
          let shopName = "";
          const shopHeader = document.querySelector('.im-dashboard-container, [class*=\"dashboard\"]');
          if (shopHeader) {
            const headerText = shopHeader.innerText || "";
            shopName = headerText.split('\\n')[0] || "";
          }
          
          // 确保勾选“只看未读”复选框（利用高性能 CSS 选择器匹配）
          let checkbox = document.querySelector('label.jd-im-checkbox-wrapper input.jd-im-checkbox-input');
          if (!checkbox) {
            const labelSpan = document.querySelector('span[title=\"只看未读\"]');
            if (labelSpan) {
              const label = labelSpan.closest('label');
              if (label) checkbox = label.querySelector('input[type=\"checkbox\"]');
            }
          }
          if (checkbox && !checkbox.checked) {
            checkbox.click();
            return { success: true, action: "checking_unread", hasUnread: false, unreadCount: 0, shopName };
          }
          
          // 获取当前未回复的顾客列表
          const customerItems = Array.from(document.querySelectorAll('.sc-ipUnzB, [class*=\"customer-item\"]'));
          const unreadCount = customerItems.length;
          
          if (unreadCount === 0) {
            return { success: true, hasUnread: false, unreadCount: 0, shopName };
          }
          
          // 提取第一个未读顾客的昵称
          const firstCustomer = customerItems[0];
          const rawText = firstCustomer.innerText || "";
          const targetCustomer = rawText.split('\\n')[0].trim();
          
          // 读取右侧当前正在对话的顾客名字
          const currentChatHeader = document.querySelector('.sc-cpclqO span') || 
                                    document.querySelector('[class*=\"chat-header\"] span') ||
                                    document.querySelector('[class*=\"title\"] span');
          const currentChatCustomer = currentChatHeader ? currentChatHeader.innerText.trim() : "";
          
          // 对比当前会话和待回复会话。如果不一致，则点击切换，并立即返回（让右侧在下一轮轮询前自然加载完成）
          const cleanTarget = targetCustomer.replace(/\\*/g, '');
          const cleanCurrent = currentChatCustomer.replace(/\\*/g, '');
          if (!cleanCurrent || !cleanCurrent.includes(cleanTarget)) {
            firstCustomer.click();
            return { 
              success: true, 
              action: "switching_session", 
              targetCustomer, 
              currentChatCustomer, 
              hasUnread: false, 
              unreadCount, 
              shopName 
            };
          }
          
          // 若已经处于当前未读会话中，读取最新消息
          let latestText = "";
          const bubbleContainers = Array.from(document.querySelectorAll('.sc-CZWsc div[class*=\"bubble\"], [class*=\"msg-content\"]'));
          if (bubbleContainers.length > 0) {
            latestText = bubbleContainers[bubbleContainers.length - 1].innerText || "";
          }
          
          // 检测是否已经有过客服回复记录
          const chatContainer = document.querySelector('.sc-CZWsc') || 
                                document.querySelector('[class*=\"chat-message-list\"]') || 
                                document.querySelector('[class*=\"chat-container\"]');
          const chatText = chatContainer ? chatContainer.innerText : '';
          const hasRepliedBefore = chatText.includes('客服') || 
                                   chatText.includes('店小二') ||
                                   chatText.includes('自动回复') ||
                                   chatText.includes('收到您的消息');
          
          return {
            success: true,
            hasUnread: true,
            unreadCount,
            shopName: shopName || targetCustomer,
            customerName: targetCustomer,
            latestText: latestText.substring(0, 100).trim(),
            hasRepliedBefore
          };
          
        } catch (e) {
          return { success: false, error: e.message };
        }
      })()`);
      
      // 每 5 次轮询（约 15 秒）输出一次运行心跳，增强诊断可视化
      if (loopCount >= 5) {
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
          const sendResult = await evaluateInBrowser(conn.ws, `(() => {
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
            await new Promise(r => setTimeout(r, 2000)); // 成功后短暂延时
          } else {
            console.error(`${displayShop} [ERROR] 回复发送失败: ${sendResult ? sendResult.error : '未知错误'}`);
          }
        }
      }
      
    } catch (err) {
      console.error(`${shopLabel} [ERROR] 轮询异常:`, err.message);
      if (err.message.includes("CDP 执行超时") || err.message.includes("WebSocket") || err.message.includes("关闭")) {
        break; // 退出当前监测，等待重新接入
      }
    }
    
    await new Promise(r => setTimeout(r, config.pollIntervalMs));
  }
}

// 启动服务
main();
