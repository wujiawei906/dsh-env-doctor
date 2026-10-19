# 环境医生（@local/dsh-env-doctor）

一个 Host 插件（bundle）。它给 agent 增加一个工具 `ensure_environment`：**读取项目文件 → 判断本机运行环境是否配置完善 → 不完善就自动补齐**。

## 用法

在对话里直接说「检查一下当前项目的运行环境」「把环境配好」，agent 会调用：

```
ensure_environment(directory?, autoFix?, installDependencies?, allowRuntimeDownload?, manageEnvFile?, installTimeoutMs?)
```

| 参数 | 默认 | 说明 |
|---|---|---|
| `directory` | 当前工作区 | 要检查的项目目录 |
| `autoFix` | `true` | `false` 时只诊断、不修改任何东西 |
| `installDependencies` | `true` | 是否允许跑包管理器安装依赖 |
| `allowRuntimeDownload` | `true` | 本机完全没有所需运行时（Node.js/CPython）时，是否下载便携版到 `$DSH_HOME/dsh-runtimes/env-doctor` |
| `manageEnvFile` | `true` | 是否允许依据 `.env` 模板生成/补全 `.env` |
| `installTimeoutMs` | `900000` | 单条安装/下载命令超时 |

返回结构化的 `checks` / `repairs` / `verdict`（`complete` / `repaired` / `incomplete` / `no-manifest`），并在会话中渲染成中文报告。

## 读什么文件

读取项目目录下实际存在的清单文件（不存在就跳过）：

- **Node.js**：`package.json`（`engines.node`、`packageManager`、`dependencies`/`devDependencies`）、`pnpm-lock.yaml`、`package-lock.json`、`yarn.lock`、`bun.lock(b)`
- **Python**：`requirements.txt`、`pyproject.toml`（PEP 621 `[project]` 与 `[tool.poetry.dependencies]`）、`Pipfile`、`environment.yml`、`setup.py`
- **版本声明**：`.nvmrc`、`.node-version`、`.python-version`、`.tool-versions`
- **环境变量**：`.env.example`、`.env.sample`、`.env.template`
- **附加信息**：`Dockerfile`、`docker-compose.yml`、`Makefile`、`justfile`、`Taskfile.yml`
- **显式声明（可选）**：`.dsh-env.json`

### 显式声明 `.dsh-env.json`

需要精确控制时，在项目里放这个文件（自动识别时不需要它）：

```json
{
  "runtimes": { "node": ">=20", "python": ">=3.11", "pnpm": "*", "git": "*" },
  "env": ["API_KEY", "FEATURE_FLAG"],
  "commands": [
    { "id": "build", "title": "构建检查", "command": "pnpm", "args": ["run", "build"], "expectExitCode": 0, "timeoutMs": 120000 }
  ],
  "setup": [
    { "id": "migrate", "title": "初始化数据库", "command": "pnpm", "args": ["run", "migrate"] }
  ]
}
```

- `runtimes`：覆盖自动推导的版本要求
- `env`：除 `.env` 模板外额外要求的变量
- `commands`：诊断阶段逐条执行，退出码不等于 `expectExitCode` 即判定不完善
- `setup`：只在诊断发现问题、且 `autoFix` 打开时执行一次

## 判断与修复

| 检查项 | 判断依据 | 自动修复 |
|---|---|---|
| `runtime:node` / `runtime:python` | PATH、Windows 常见安装目录、`$DSH_HOME/dsh-runtimes` 下的捆绑运行时；比对 `.nvmrc`/`engines`/`.dsh-env.json` 的版本要求 | 缺失/版本不符时下载便携版（`nodejs.org` / `python-build-standalone`）到 `$DSH_HOME/dsh-runtimes/env-doctor` |
| `runtime:pnpm` | 项目锁文件或 `packageManager` 声明 pnpm 时检查 | 缺失则改用已有的 npm/yarn/bun，并在报告中说明 |
| `runtime:git` | 目录含 `.git` 或显式声明时 | 只报告（不自动安装 Git） |
| `deps:node` | 直接依赖是否都在 `node_modules`；锁文件是否比安装记录新 | 用项目对应的包管理器执行 `install` |
| `deps:python` | `pip list` 与声明的依赖逐个比对（含 `==` 固定版本） | 复用或创建 `.venv`，再 `pip install -r requirements.txt`（无 requirements 时 `pip install .`） |
| `env:file` | 模板键 + 显式声明键 是否在 `.env` 或进程环境中存在 | 生成 `.env`，或向已有 `.env` 追加空值键 |
| `command:*` | 显式声明的检查命令 | 只报告 |

修复后会**重新检查一遍**，把修好的项标为「已修复」，最终 `verdict` 为 `repaired`；仍有未解决项则为 `incomplete`。

安全边界：不修改系统 `PATH`、不装全局包、不动容器配置、不改注册表；下载的运行时只落在 `$DSH_HOME/dsh-runtimes/env-doctor`，通过参数可全部关闭（`autoFix: false` 即纯诊断）。

## 安装与卸载

这是一个 DSH bundle 包，从 GitHub 直接安装即可（安装后重启一次 Harness 生效）：

```powershell
dsh plugin --profile desktop add https://github.com/wujiawei906/dsh-env-doctor
```

开发时也可以用本地目录：`dsh plugin --profile desktop add C:\path\to\dsh-env-doctor`，
用 `link:` 方式安装后改源码只需重载 profile。

卸载：在 Web 侧边栏「插件」页把该 bundle 关掉/移除，或从 profile 的
`dsh.profile.bundles` 删掉 `@local/dsh-env-doctor`，再在 profile 目录执行
`pnpm remove @local/dsh-env-doctor`。

## 目录结构

```
index.js            工具定义（参数、输出 schema、报告渲染）
lib/diagnose.js     编排：读清单 → 探测 → 判定 → 修复 → 复检
lib/manifests.js    清单发现与解析
lib/runtimes.js     运行时发现（捆绑 / PATH / 常见安装目录）与版本探测
lib/download.js     便携运行时下载与解包
lib/repair.js       各类修复动作
lib/exec.js         子进程执行（有超时、可取消、不抛异常）
lib/version.js      版本解析与要求匹配
```
