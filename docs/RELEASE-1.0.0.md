# LinuxPlay1.0.0版本说明

LinuxPlay首个Linux版本，将WinPlay的无线CarPlay接收功能迁移到Linux桌面，并参考MacPlay的跨平台实现。连接、显示、音频、关于四页保留原有布局、交互和语言资源，采用简约Linux图标，界面、托盘与接收端名称统一为LinuxPlay。

## 主要功能

- 本机热点与现有局域网两种无线模式，分别保存网络配置，支持自动或手动选择接口。
- 通过BlueZ完成蓝牙连接引导，使用NetworkManager读取热点与当前Wi-Fi配置。
- 独立CarPlay窗口，支持鼠标点击、拖动、触控板滚动、多显示器、自定义分辨率与全屏窗口化。
- 默认1280×720、60fps，可选30/60/90/120fps，并保留高帧率失败时的降级重连。
- 媒体/通话音量控制、音频设备选择，以及MPRIS系统媒体信息和播放控制。
- 简体中文、繁體中文、English、跟随系统语言，以及浅色/深色外观。
- 托盘后台运行、可选被动断线重连、认证文件导入和诊断日志导出。

本版提供无线CarPlay，不提供USB直连。

## 运行要求

- X11/XWayland图形桌面，具备可用蓝牙适配器及BlueZ服务。
- Python3支持Linux蓝牙socket，NetworkManager管理当前网络，安装`xrandr`以读取显示器信息。
- 桌面音频服务、用户会话D-Bus和可用的桌面密钥环。
- 支持CarPlay的iPhone，开启Wi-Fi与蓝牙，两端网络允许互访。
- 安装包已内嵌配套认证文件；关于页可按需更换。

严格物理像素与窗口定位需要X11/XWayland。托盘显示和系统媒体控件取决于桌面环境提供的相应支持。

## 安装与连接

安装包提供AppImage与deb，内置Electron、独立Node运行时和接收引擎。64位Intel/AMD电脑使用`LinuxPlay-1.0.0-x86_64.AppImage`或`LinuxPlay-1.0.0-amd64.deb`，ARM64设备使用同架构构建的`arm64`包。安装步骤与源码构建见[README](https://github.com/Roylyl/LinuxPlay#readme)。

安装包内嵌配套认证文件，首次启动无需手动导入。在系统蓝牙设置中配对iPhone，再选择本机热点或现有局域网，读取或填写实际网络信息，点击“启动接收”并在iPhone上允许CarPlay。收到首帧并完成解码后，独立画面窗口自动显示。

本机热点需先在系统网络设置中开启。电脑通过以太网接入局域网时，手动填写iPhone所在Wi-Fi的名称、共享密码和实际信道。读取保存的密码需要NetworkManager授权，也可直接手动填写。

设置、认证文件与配对数据保存在`$XDG_CONFIG_HOME/LinuxPlay/data`，默认路径为`~/.config/LinuxPlay/data`。替换应用包时保留同一用户的数据目录。

## 许可与来源

LinuxPlay基于WinPlay，参考MacPlay与AndroidPlay，保留LIVI和DiPlay相关来源声明。项目遵循GPL-3.0-or-later，认证材料和商标分别适用各自权利条件。详见[LICENSE](https://github.com/Roylyl/LinuxPlay/blob/HEAD/LICENSE)、[NOTICE](https://github.com/Roylyl/LinuxPlay/blob/HEAD/NOTICE)和[源码来源说明](https://github.com/Roylyl/LinuxPlay/blob/HEAD/vendor/SOURCE-AUDIT.md)。

## 本次修正

- 修复部分Wayland桌面启动后不显示主窗口，启动入口自动使用XWayland。
- 修复深色主题语言下拉菜单文字不清晰。
- 统一界面、托盘和iPhone接收端显示名称为LinuxPlay，保留原有页面布局与操作流程。
- 内嵌配套认证文件，首次安装后无需手动导入。

- 修复GNOME/Wayland分数缩放下将XWayland虚拟画布误认为屏幕物理分辨率的问题，读取当前显示模式与系统缩放，并同步调整画面窗口尺寸。

- 对齐WinPlay网络操作流程：重新检测仅刷新网卡状态，点击“读取当前网络和密码”才回填；启动接收时仍自动核对当前热点参数。
- 修正关于页初始版本文字为1.0.0。

## 深度检查修正

- 修复本机热点接口在局域网模式中被当成普通Wi-Fi选择的问题；单个无线接口查询失败不影响其他可用有线连接。
- 修复AppImage免FUSE提取运行时，自动重启丢失提取参数导致无法打开的问题。
- 补齐Linux网络、蓝牙、凭据权限错误的繁体中文和英文提示。
- 修复严格像素窗口跨不同缩放显示器移动时沿用旧比例的问题，并检查窗口实际尺寸的上下界。
- 显示模式或缩放变化时刷新GNOME显示配置，启动前重新确认物理尺寸，取消操作不会被迟到的读取结果恢复。
- X11只有当前活动模式与显示几何一致时才允许严格像素模式；普通适配模式尺寸设置失败时保持播放。
