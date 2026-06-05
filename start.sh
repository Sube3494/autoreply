#!/bin/bash
set -e

# 1. 启动 Xvfb 虚拟屏幕，设置分辨率为 1920x1080 色深 24
Xvfb :99 -screen 0 1920x1080x24 &
export DISPLAY=:99
sleep 1  # 等待虚拟屏幕初始化

# 2. 启动 Fluxbox 窗口管理器以管理浏览器窗口
fluxbox &
sleep 1  # 等待窗口管理器就绪

# 3. 启动 x11vnc，显式监听 127.0.0.1 以规避 localhost 解析问题
x11vnc -display :99 -forever -shared -nopw -listen 127.0.0.1 -xkb &
sleep 1  # 等待 VNC 服务绑定端口

# 4. 启动 noVNC 代理服务，将 VNC 画面代理至 6080 端口
/opt/novnc/utils/novnc_proxy --vnc 127.0.0.1:5900 --listen 0.0.0.0:6080 &
echo "[start.sh] noVNC 网页投影客户端已在 6080 端口就绪！"

# 5. 启动自带的 Google Chrome，启用 9222 调试端口并持久化用户数据目录
google-chrome-stable \
    --remote-debugging-port=9222 \
    --user-data-dir=/app/chrome_profile \
    --no-sandbox \
    --disable-dev-shm-usage \
    --start-maximized \
    --window-size=1920,1080 \
    "https://store.jddj.com/frame/1032/5120" &

# 6. 等待浏览器完全打开并建立调试接口
sleep 5

# 7. 启动客服监测自动回复服务
echo "[start.sh] 正在启动自动回复监测程序..."
node index.js
