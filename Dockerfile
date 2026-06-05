FROM node:24-bullseye

# 1. 安装系统图形支持软件、中文字体以及 Xvfb / VNC 桌面环境
RUN apt-get update && apt-get install -y \
    wget \
    gnupg \
    ca-certificates \
    procps \
    xvfb \
    x11vnc \
    fluxbox \
    dbus-x11 \
    fonts-wqy-microhei \
    && wget -q https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb \
    && apt-get install -y ./google-chrome-stable_current_amd64.deb \
    && rm google-chrome-stable_current_amd64.deb \
    && rm -rf /var/lib/apt/lists/*

# 2. 安装 noVNC（让我们可以直接在浏览器中操控容器内 Chrome 画面）
RUN mkdir -p /opt/novnc && \
    wget -qO- https://github.com/novnc/noVNC/archive/v1.4.0.tar.gz | tar xz -C /opt/novnc --strip-components=1 && \
    mkdir -p /opt/novnc/utils/websockify && \
    wget -qO- https://github.com/novnc/websockify/archive/v0.11.0.tar.gz | tar xz -C /opt/novnc/utils/websockify --strip-components=1 && \
    ln -s /opt/novnc/vnc.html /opt/novnc/index.html

# 设置中国标准时区（东八区）
ENV TZ=Asia/Shanghai
RUN ln -snf /usr/share/zoneinfo/$TZ /etc/localtime && echo $TZ > /etc/timezone

WORKDIR /app

# 3. 复制相关项目代码文件
COPY config.json index.js package.json ./

# 4. 复制启动引导脚本并授权
COPY start.sh /start.sh
RUN chmod +x /start.sh

# 暴露 noVNC 网页服务端口
EXPOSE 6080

CMD ["/start.sh"]
