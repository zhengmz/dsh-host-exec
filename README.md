<div align="center">

# DSH Host Exec

**DSH 插件 —— 在宿主机（而非沙箱）执行命令行**

绕过 DSH 的 rootless bwrap 沙箱，在 **宿主进程** 中运行命令，可访问宿主上的真实资源：GPU（`/dev/nvidia*`）、宿主 tmux 会话、`/tmp` socket 等——**无论是否与 GPU 有关**。

[English](README.en.md) · 中文

</div>

---

## 它解决什么问题

DSH 默认的 `bash` 工具在 **rootless bwrap 沙箱** 中执行，该沙箱：

- 屏蔽了宿主设备节点（`--dev /dev` 盖住宿主 devtmpfs），GPU 不可见；
- 即使打补丁让设备节点可见，rootless userns + cgroup 拦截仍会让 `open("/dev/nvidia*")` 返回 `EACCES`；
- 沙箱网络共享、但进程、socket、`/tmp` 每次调用都会销毁。

实测：沙箱内 `nvidia-smi` 报 `couldn't communicate with the NVIDIA driver`，而宿主用户可直接打开 GPU 设备。

`dsh-host-exec` 把工具注册进 **DSH 宿主 node 进程**（不是 bash 沙箱），用 `child_process.spawn` 在宿主侧执行，因此天然绕开隔离，能访问宿主上任何用户有权访问的资源。

## 功能特性

- ✅ 在宿主本地进程执行任意命令（`shell`）
- ✅ **分离模式** `detach: true`：启动长时进程（如仿真）并返回 pid，宿主进程持久存活
- ✅ **前台模式**（默认）：运行到结束，捕获 stdout/stderr 与退出码
- ✅ 超时控制（默认 300s，可配）与输出字节上限
- ✅ 配置化的命令前缀 **allow / deny 名单**
- ✅ 遵循 Cordis 标准 `inject` / `apply` / `Config` 约定

## 安装

从 GitHub 安装（仓库：`zhengmz/dsh-host-exec`）。DSH 会在 profile 目录里运行 pnpm 从 GitHub 拉取，并把声明了 `dsh.bundle.patch` 的插件**自动加入** `dsh.profile.bundles`：

```bash
npx @deepseek-ai/dsh plugin --profile web add github:zhengmz/dsh-host-exec
```

> 若本地开发想直接使用工作区源码，可用本地路径：`npx @deepseek-ai/dsh plugin --profile web add /path/to/dsh-host-exec`。
> 注意：对本地目录 `dsh plugin add` 默认使用 pnpm `link:`（软链接到源目录）。若插件因此从源目录加载而导致 `@deepseek-ai/dsh-tools` 等解析失败（`MODULE_NOT_FOUND`），请在插件所在目录的父链提供到 DSH 运行时刻包的 `node_modules/@deepseek-ai` 链接：
>
> ```bash
> mkdir -p /path/to/dsh-host-exec/../../node_modules/@deepseek-ai
> ln -s <dsh-npx-dir>/node_modules/@deepseek-ai/dsh-tools   /path/to/.../node_modules/@deepseek-ai/dsh-tools
> ln -s <dsh-npx-dir>/node_modules/@deepseek-ai/schemastery /path/to/.../node_modules/@deepseek-ai/schemastery
> ```

安装后**重启 DSH**，你的会话工具列表里就会出现 `host_exec`。

## 配置（Config）

通过 profile 的配置层注入（`allowPrefixes` / `denyPrefixes` 均可用 `DISPLAY` 无关，为命令前缀黑/白名单）：

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `allowPrefixes` | `string[]` | `[]` | 命令前缀白名单；空 = 允许任何命令 |
| `denyPrefixes` | `string[]` | `[]` | 命令前缀黑名单（在黑名单后检查） |
| `defaultTimeoutMs` | `number` | `300000` | 前台运行默认超时（毫秒） |
| `maxOutputBytes` | `number` | `2000000` | 单次收集 stdout/stderr 的上限（字节） |

## 工具：`host_exec`

### 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `command` | `string` | ✅ | 要执行的 shell 命令 |
| `cwd` | `string` | | 工作目录，默认宿主用户家目录 |
| `detach` | `boolean` | | `true` 分离启动并返回 pid；`false`/省略 = 前台运行到结束 |
| `timeoutMs` | `number` | | 前台运行超时，覆盖默认值 |

### 输出

| 字段 | 类型 | 说明 |
|------|------|------|
| `ok` | `boolean` | 命令退出码为 0（或分离启动成功）|
| `mode` | `string` | `run`（前台完成）/ `detached`（分离启动）/ `blocked`（被名单拦截）|
| `pid` | `number` | `detached` 时的进程 pid |
| `exitCode` | `number` | `run` 时的退出码 |
| `timedOut` | `boolean` | 是否超时 |
| `stdout` / `stderr` | `string` | 收集的输出（已截断到上限）|

### 示例

```json
{
  "command": "nvidia-smi",
  "detach": false
}
```

```json
{
  "command": "cd /home/arms/gazebo_ws && ./run_gazebo.sh -n my_sim",
  "cwd": "/home/arms",
  "detach": true
}
```

## 安全说明

> ⚠️ **本插件有意绕过文件/设备沙箱，为它运行的命令提供宿主级权限。** 这等价于在宿主机以当前用户身份直接执行任意命令。**仅在可信的私有部署上挂载**，并建议配置 `allowPrefixes` / `denyPrefixes` 收窄可执行命令范围。

## 本地开发与验证

```bash
node --check lib/index.js            # 语法检查
# 加载验证（需能解析 @deepseek-ai/*）
node --input-type=module -e "import('./lib/index.js').then(m=>console.log(m.name, typeof m.apply))"
```

## 目录结构

```
dsh-host-exec/
├── package.json        # name=dsh-host-exec, 声明 dsh.bundle.patch
├── cordis.patch.yml    # bundle 挂载声明（name: dsh-host-exec）
├── lib/
│   └── index.js        # 插件实现（定义 host_exec 工具）
├── README.md           # 中文文档
└── README.en.md        # English docs
```

## 卸载

```bash
npx @deepseek-ai/dsh plugin --profile web remove dsh-host-exec
```

