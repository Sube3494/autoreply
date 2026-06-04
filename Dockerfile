FROM node:24-bullseye

# 1. 安装系统图形支持软件、Google Chrome 稳定版、Xvfb 和 VNC
RUN apt-get update && apt-get install -y \
    wget \
    gnupg \
    ca-certificates \
    procps \
    xvfb \
    x11vnc \
    fluxbox \
    dbus-x11 \
    && wget -q -O - https://dl-ssl.google.com/linux/linux_signing_key.pub | apt-key add - \
    && sh -c 'echo "deb [arch=amd64] http://dl.google.com/linux/chrome/deb/ stable main" >> /etc/apt/sources.list.d/google.list' \
    && apt-get update \
    && apt-get install -y google-chrome-stable \
    && rm -rf /var/lib/apt/lists/*

# 2. 安装 noVNC（让我们可以直接在浏览器中操控容器内 Chrome 画面）
RUN mkdir -p /opt/novnc && \
    wget -qO- https://github.com/novnc/noVNC/archive/v1.4.0.tar.gz | tar xz -C /opt/novnc --strip-components=1 && \
    mkdir -p /opt/novnc/utils/websockify && \
    wget -qO- https://github.com/novnc/websockify/archive/v0.11.0.tar.gz | tar xz -C /opt/novnc/utils/websockify --strip-components=1

WORKDIR /app

# 3. 复制相关项目代码文件
COPY config.json index.js package.json ./

# 4. 复制启动引导脚本并授权
COPY start.sh /start.sh
RUN chmod +x /start.sh

# 暴露 noVNC 网页服务端口
EXPOSE 6080

CMD ["/start.sh"]
