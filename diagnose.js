const http = require('http');
// 直接使用 Node 22+ 的全局 WebSocket 运行诊断，无需第三方依赖

const chromeDebugUrl = "http://127.0.0.1:9222";

async function getPages() {
  return new Promise((resolve, reject) => {
    http.get(`${chromeDebugUrl}/json`, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', reject);
  });
}

function evaluate(ws, expression, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const id = Date.now() + Math.floor(Math.random() * 1000);
    const payload = JSON.stringify({
      id,
      method: "Runtime.evaluate",
      params: {
        expression,
        awaitPromise: false,
        returnByValue: true
      }
    });

    const timeout = setTimeout(() => {
      ws.removeEventListener('message', handle);
      reject(new Error(`CDP 执行超时 (${timeoutMs}ms)`));
    }, timeoutMs);

    function handle(event) {
      const response = JSON.parse(event.data);
      if (response.id === id) {
        clearTimeout(timeout);
        ws.removeEventListener('message', handle);
        if (response.error) {
          reject(response.error);
        } else if (response.result && response.result.result) {
          resolve(response.result.result.value);
        } else {
          resolve(null);
        }
      }
    }

    ws.addEventListener('message', handle);
    ws.send(payload);
  });
}

async function run() {
  console.log("=== 开始诊断容器内 Chrome 调试端口 ===");
  try {
    const pages = await getPages();
    console.log(`获取到页面列表 (${pages.length} 个):`);
    pages.forEach(p => {
      console.log(`- ID: ${p.id}\n  标题: ${p.title}\n  URL: ${p.url}\n  WS_URL: ${p.webSocketDebuggerUrl}\n`);
    });

    const targetPages = pages.filter(p => p.type === 'page' && (p.url.includes('imSettings') || p.url.includes('store.jddj.com/notify/') || p.url.includes('store.jddj.com/frame/')));
    if (targetPages.length === 0) {
      console.log("未找到匹配的目标客服标签页。");
      return;
    }

    for (const page of targetPages) {
      console.log(`开始连接页面: "${page.title}" (${page.url})`);
      const ws = new WebSocket(page.webSocketDebuggerUrl);

      await new Promise((resolve) => {
        ws.addEventListener('open', async () => {
          console.log("-> WebSocket 连接成功！");

          // 测试 1：极简求值
          try {
            const t0 = Date.now();
            console.log("测试 1：执行 1 + 1...");
            const val1 = await evaluate(ws, "1 + 1");
            console.log(`测试 1 成功，结果: ${val1}，耗时: ${Date.now() - t0}ms`);
          } catch (e) {
            console.error("测试 1 失败:", e.message);
          }

          // 测试 2：读取基本 DOM 元素
          try {
            const t0 = Date.now();
            console.log("测试 2：获取 document.title...");
            const val2 = await evaluate(ws, "document.title");
            console.log(`测试 2 成功，结果: ${val2}，耗时: ${Date.now() - t0}ms`);
          } catch (e) {
            console.error("测试 2 失败:", e.message);
          }

          // 测试 3：测试“只看未读”复选框的查找
          try {
            const t0 = Date.now();
            console.log("测试 3：寻找‘只看未读’元素...");
            const val3 = await evaluate(ws, `(() => {
              const checkbox = document.querySelector('label.jd-im-checkbox-wrapper input.jd-im-checkbox-input');
              const labelSpan = document.querySelector('span[title="只看未读"]');
              return {
                checkboxExist: !!checkbox,
                labelSpanExist: !!labelSpan,
                bodyTextLength: document.body ? document.body.innerText.length : 0
              };
            })()`);
            console.log(`测试 3 成功，结果:`, val3, `，耗时: ${Date.now() - t0}ms`);
          } catch (e) {
            console.error("测试 3 失败:", e.message);
          }

          // 测试 4：执行完整监测逻辑
          try {
            const t0 = Date.now();
            console.log("测试 4：执行完整监测脚本...");
            const val4 = await evaluate(ws, `(() => {
              try {
                let shopName = "";
                const shopHeader = document.querySelector('.im-dashboard-container, [class*="dashboard"]');
                if (shopHeader) {
                  const headerText = shopHeader.innerText || "";
                  shopName = headerText.split('\\n')[0] || "";
                }
                
                let checkbox = document.querySelector('label.jd-im-checkbox-wrapper input.jd-im-checkbox-input');
                if (!checkbox) {
                  const labelSpan = document.querySelector('span[title="只看未读"]');
                  if (labelSpan) {
                    const label = labelSpan.closest('label');
                    if (label) checkbox = label.querySelector('input[type="checkbox"]');
                  }
                }
                
                const customerItems = Array.from(document.querySelectorAll('.sc-ipUnzB, [class*="customer-item"]'));
                const unreadCount = customerItems.length;
                
                return {
                  shopName,
                  hasCheckbox: !!checkbox,
                  checkboxChecked: checkbox ? checkbox.checked : false,
                  unreadCount
                };
              } catch (e) {
                return { error: e.message };
              }
            })()`);
            console.log(`测试 4 成功，结果:`, val4, `，耗时: ${Date.now() - t0}ms`);
          } catch (e) {
            console.error("测试 4 失败:", e.message);
          }

          ws.close();
          resolve();
        });

        ws.addEventListener('error', (err) => {
          console.log("WebSocket 连接出错");
          resolve();
        });
      });
    }

  } catch (err) {
    console.error("诊断异常:", err.message);
  }
}

run();
