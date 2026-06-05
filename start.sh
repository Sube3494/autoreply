#!/bin/bash
set -e

# 设置系统默认语言环境为中文，确保 Chrome 内部优先使用中文包
export LANG=zh_CN.UTF-8
export LANGUAGE=zh_CN:zh
export LC_ALL=zh_CN.UTF-8

# 1. 启动 Xvfb 虚拟屏幕，设置分辨率为较轻量、低负载的 1280x800 色深 24
Xvfb :99 -screen 0 1280x800x24 &
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

# 5. 启动自带的 Google Chrome，显式绑定 DISPLAY 变量，并重定向启动日志到文件以供诊断
# 核心：将数据目录改为 /root/chrome_profile，规避工作区权限冲突，并加上调试诊断重定向
DISPLAY=:99 google-chrome-stable \
    --remote-debugging-port=9222 \
    --user-data-dir=/root/chrome_profile \
    --no-sandbox \
    --disable-dev-shm-usage \
    --disable-gpu \
    --disable-software-rasterizer \
    --start-maximized \
    --window-size=1280,800 \
    --lang=zh-CN \
    --test-type \
    "https://store.jddj.com/frame/1032/5120" > /app/chrome_start.log 2>&1 &

# 6. 等待浏览器完全打开并建立调试接口
sleep 5

# 7. 启动客服监测自动回复服务
echo "[start.sh] 正在启动自动回复监测程序..."
node index.js
