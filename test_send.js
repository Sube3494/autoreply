const fs = require('fs');

async function run() {
  try {
    const res = await fetch("http://127.0.0.1:9222/json");
    const data = await res.json();
    
    let targetPage = data.find(p => p.type === 'page' && p.url.includes('imSettings'));
    if (!targetPage) {
      targetPage = data.find(p => p.type === 'page' && p.url.includes('store.jddj.com'));
    }
    
    if (!targetPage) {
      console.error("未找到京东秒送活动页面，请确保浏览器已打开相关网页！");
      return;
    }
    
    console.log(`连接至目标客服页面: ${targetPage.title} (${targetPage.url})`);
    const ws = new WebSocket(targetPage.webSocketDebuggerUrl);
    
    await new Promise((resolve) => {
      ws.onopen = () => resolve();
    });
    
    const evaluateCmd = {
      id: 11,
      method: "Runtime.evaluate",
      params: {
        expression: `(async () => {
          try {
            console.log("IM 自动回复测试开始...");
            
            // 0. 自动切换到“顾客消息” Tab，确保能展示出历史会话
            const allCustomerTab = document.querySelector('[data-node-key="allCustomer"]');
            if (allCustomerTab) {
              console.log("正在切换到'顾客消息'Tab...");
              allCustomerTab.click();
              await new Promise(r => setTimeout(r, 1500));
            }
            
            // 1. 查找左侧顾客列表
            let customerItems = Array.from(document.querySelectorAll('.sc-ipUnzB, [class*="customer-item"]'));
            
            if (customerItems.length === 0) {
              const bodyText = document.body ? document.body.innerText.substring(0, 400).replace(/\\n/g, ' ') : '';
              return { success: false, step: "点击顾客", error: "未找到任何顾客列表项。页面文字: " + bodyText };
            }
            
            const firstCustomer = customerItems[0];
            const customerName = firstCustomer.innerText.replace(/\\n/g, ' ');
            console.log("找到顾客会话: " + customerName + "，准备点击...");
            
            firstCustomer.click();
            await new Promise(r => setTimeout(r, 1500)); // 等待会话加载
            
            // 2. 深入挖掘右侧输入框
            let editor = document.querySelector('[contenteditable="true"]') ||
                         document.querySelector('textarea') ||
                         document.querySelector('[placeholder="说点什么"]');
                         
            if (!editor) {
              const speakPlaceholder = Array.from(document.querySelectorAll('*'))
                .find(el => (el.innerText || '').trim() === '说点什么');
              if (speakPlaceholder) {
                const parent = speakPlaceholder.parentElement;
                editor = parent.querySelector('[contenteditable]') || parent.querySelector('textarea') || parent;
              }
            }
            
            if (!editor) {
              const enterSendArea = Array.from(document.querySelectorAll('*'))
                .find(el => (el.innerText || '').includes('Enter发送'));
              if (enterSendArea) {
                editor = enterSendArea.querySelector('[contenteditable]') || 
                         enterSendArea.querySelector('textarea') || 
                         enterSendArea.querySelector('div[class*="editor"]');
              }
            }
            
            if (!editor) {
              const rightContainer = document.querySelector('.sc-CZWsc') || document.body;
              return { 
                success: false, 
                step: "查找输入框", 
                error: "未找到可编辑的输入框节点",
                htmlSnippet: rightContainer.innerHTML.substring(0, 1000)
              };
            }
            
            const editorInfo = {
              tagName: editor.tagName,
              className: editor.className,
              isContentEditable: editor.contentEditable === 'true' || editor.getAttribute('contenteditable') === 'true'
            };
            console.log("定位到输入框:", editorInfo);
            
            // 3. 填入测试内容
            const testText = "【自动回复测试】您好，已收到您的新咨询，我们将尽快为您服务！";
            editor.focus();
            
            if (editorInfo.isContentEditable) {
              editor.innerHTML = testText;
              editor.dispatchEvent(new Event('input', { bubbles: true }));
              editor.dispatchEvent(new Event('change', { bubbles: true }));
              
              try {
                const range = document.createRange();
                range.selectNodeContents(editor);
                range.collapse(false);
                const sel = window.getSelection();
                sel.removeAllRanges();
                sel.addRange(range);
                document.execCommand('insertText', false, testText);
              } catch (e) {
                console.warn("execCommand 插入文本失败:", e.message);
              }
            } else {
              editor.value = testText;
              editor.dispatchEvent(new Event('input', { bubbles: true }));
              editor.dispatchEvent(new Event('change', { bubbles: true }));
            }
            
            await new Promise(r => setTimeout(r, 500));
            
            // 4. 查找发送按钮并点击
            const sendBtn = Array.from(document.querySelectorAll('button, div, span'))
              .find(el => (el.innerText || '').trim() === '发送' && el.tagName !== 'SPAN');
              
            if (!sendBtn) {
              return { 
                success: false, 
                step: "查找发送按钮", 
                error: "未找到带有 '发送' 文字的按钮",
                editorInfo
              };
            }
            
            console.log("找到发送按钮，类名:", sendBtn.className, "。准备点击...");
            
            // 模拟点击发送
            sendBtn.click();
            
            return {
              success: true,
              clickedCustomer: customerName,
              editorInfo,
              sendBtnClass: sendBtn.className,
              injectedText: testText
            };
            
          } catch (err) {
            return { success: false, step: "执行捕获", error: err.message };
          }
        })()`,
        awaitPromise: true,
        returnByValue: true
      }
    };
    
    ws.send(JSON.stringify(evaluateCmd));
    
    const response = await new Promise((resolve) => {
      ws.onmessage = (event) => {
        const response = JSON.parse(event.data);
        if (response.id === 11) {
          resolve(response);
        }
      };
    });
    
    ws.close();
    
    if (response.error || !response.result || !response.result.result) {
      console.error("执行失败:", response.error || response.result);
    } else {
      const result = response.result.result.value;
      console.log("=== 消息发送验证结果 ===");
      console.log(JSON.stringify(result, null, 2));
    }
  } catch (err) {
    console.error("连接/执行出错:", err);
  }
}
run();
