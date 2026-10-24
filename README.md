# StartRide 联机服务器（Linux）

**BeamNG.drive 联机启动器 StartRide 的自建服务器一键安装包** · 像「装系统」一样的文字图形安装器，拷进 U 盘，插到 Linux 服务器上跑一条命令，装完即可联机。

> Windows 客户端主仓库：<https://github.com/CangLann-xyq/StartRide>

---

## 下载

推荐：到 [**Releases**](../../releases) 下载 **`StartRide-Server-MediaCreator-win-x64.exe`**（Windows 制作工具）——
像 Win10 安装媒体创建工具一样：选 U 盘 → 确认清空 → 一键把安装盘写进 U 盘。
安装包已内置在工具里，无需联网；做出的 U 盘是**软件插件安装盘**（不是系统盘、不可引导）。

或者直接下载 `StartRide-Server-vX.X.X.zip`，解压得到：

```
StartRide-Server/
├── install.sh                          安装器（文字图形界面，无注释纯净脚本）
├── README.txt                          精简说明
└── payload/
    ├── relay-server.js                 中继服务（含房间公告板与建房档，无注释）
    └── node-v22.22.2-linux-x64.tar.xz  内置 Node.js 运行时（离线可用）
```

## 它能做什么

- **中继转发**：TCP 7777 游戏数据 + WebSocket 隧道（默认 7788），车辆物理在房主电脑计算，服务器只转发
- **房间公告板**：`/api/startride/rooms...` 全套 HTTP 接口（建房 / 列表 / 进出房 / 房间聊天 / 心跳，90 秒无心跳自动回收）
- **建房档**：安装时像客户端建房一样选好模式、地图、出生点、人数上限 —— 装完玩家一打开大厅就能看到这个常驻房间，人数上限在服务端封顶
- **零依赖**：自带 Node.js v22.22.2（x86_64），没有外网、没有预装环境也能装

## 支持系统

Ubuntu / Debian / CentOS / RHEL / Rocky / Alma / openEuler / Alibaba Cloud Linux / Arch 等主流 systemd 发行版（x86_64 优先；arm64 走系统 Node.js 或包管理器自动安装）。

## 三步装好

**方式 A · Windows 制作工具（推荐）**：双击 `StartRide-Server-MediaCreator-win-x64.exe` → 选 U 盘 → 勾选「确认清空」→ 开始制作。完成后安全弹出 U 盘。

**方式 B · 手动拷贝**：把解压出的整个 `StartRide-Server` 文件夹拷到 U 盘。

然后：

```bash
# 1) U 盘插到 Linux 服务器并挂载，进入目录
# 2) 执行：
sudo bash install.sh
# 3) 按字符界面走完：环境检测（含硬件概览）→ 选网卡 → 端口 →
#    建房向导（模式/地图/出生点/人数）→ 确认 → 安装 → 健康检查 → 摘要
```

主菜单还提供 **卸载** 与 **查看运行状态**；免交互装机用 `sudo bash install.sh --auto`，另有 `--status` / `--uninstall`。

## 装完在 Windows 客户端怎么填

启动器 → **设置 → 联机延迟**（安装器摘要页会原样给出）：

| 项目 | 值 |
|---|---|
| 中继服务器地址 | 安装器选定的网卡 IP / 公网出口地址 |
| 直连端口（TCP） | 7777 |
| WebSocket 端口 | 7788 |
| WebSocket 路径 | /relay-ws |

填完点「测试延迟」验证两条通道，之后大厅房间列表就能看到你的服务器房间。

> **云服务器注意**：腾讯云 / 阿里云 / AWS 等，除系统防火墙（安装器已自动放行 ufw / firewalld / iptables）外，还必须在控制台 **安全组** 放行 TCP 7777 与 TCP 7788。

## 日常管理

```bash
systemctl status  start-ride-relay      # 状态（开机自启、崩溃 3 秒自动拉起）
systemctl restart start-ride-relay      # 重启
journalctl -u start-ride-relay -f       # 日志
curl http://127.0.0.1:7788/health       # 健康检查（版本 / 房间数）
curl http://127.0.0.1:7788/live         # 房间实时状态
```

- 配置：`/etc/start-ride/relay.env`（端口、房主掉线宽限）
- 建房档：`/etc/start-ride/room.json`（改名 / 换模式 / 换地图 / 改人数，改完 `systemctl restart start-ride-relay`）
- 安装摘要：`/opt/start-ride/INSTALL-SUMMARY.txt`
- 卸载：`sudo bash install.sh --uninstall`，安装目录与配置全部移除，干净可逆

## 文件结构（安装后）

```
/opt/start-ride/          安装目录（node/、relay-server.js）
/etc/start-ride/          配置（relay.env、room.json）
/etc/systemd/system/start-ride-relay.service
```

## 使用条款

联机功能由 StartRide 自建中继提供。使用本服务端即表示遵守中国大陆相关法律法规，不得用于违法用途。
