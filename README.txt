=============================================================
 StartRide 联机服务器 · 一体安装包（Linux）
=============================================================

这是什么
--------
一个像装系统一样的文字图形安装器：把整个文件夹拷到 U 盘，
插到 Linux 服务器上执行一条命令，装完就能联机。
自带 Node.js 运行时（x86_64 离线可用），不依赖任何预装环境。

支持系统
--------
Ubuntu / Debian / CentOS / RHEL / Rocky / Alma / openEuler /
Alibaba Cloud Linux / Arch 等主流 systemd 发行版。

怎么装
------
  1) 把整个 StartRide-Server 文件夹拷到 U 盘（保持目录结构完整）
  2) 插到服务器，挂载后进入该目录
  3) 执行：
         sudo bash install.sh
     蓝底白字字符界面，主菜单可选：
         全新安装 / 升级 → 卸载 → 查看运行状态 → 退出
     安装流程：环境检测（含硬件概览）→ 选网卡 → 端口配置 →
               建房向导（模式 / 地图 / 出生点 / 人数）→ 确认 →
               安装 → 健康检查 → 摘要
     网络不通、没有 node、没有 xz 都不用管，安装器自己搞定。

免交互安装（机房批量装机用）
---------------------------
         sudo bash install.sh --auto

装完之后 Windows 这边怎么填
---------------------------
启动器 → 设置 → 联机延迟：
    中继服务器地址  = 安装器摘要页给出的 IP
    直连端口（TCP） = 7777
    WebSocket 端口  = 7788
    WebSocket 路径  = /relay-ws
填完点「测试延迟」。大厅房间列表会常驻显示安装时配置的
「建房档」房间（模式 / 地图 / 出生点 / 人数上限在服务端生效），
直接加入它，或自己建房也可以。

建房档保存在 /etc/start-ride/room.json，改完
systemctl restart start-ride-relay 即生效。

云服务器注意
------------
腾讯云 / 阿里云 / AWS 等，除了系统防火墙（安装器已自动放行），
还必须在控制台「安全组」放行 TCP 7777 和 TCP 7788。

日常管理
--------
  systemctl status  start-ride-relay     # 状态
  systemctl restart start-ride-relay     # 重启
  journalctl -u start-ride-relay -f      # 看日志
  curl http://127.0.0.1:7788/health      # 健康检查
  curl http://127.0.0.1:7788/live        # 当前房间实时状态

安装摘要保存在 /opt/start-ride/INSTALL-SUMMARY.txt。

卸载
----
  sudo bash install.sh --uninstall

目录结构
--------
  install.sh                        安装器（文字图形界面）
  payload/relay-server.js           中继服务（含房间公告板）
  payload/node-v22.x-linux-x64.tar.xz  内置 Node.js 运行时
