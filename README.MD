# AI 自动化测试平台

基于自然语言维护端到端测试用例，后端通过 AI agent 生成 Playwright 脚本并执行。

## 技术栈

- 前端：React + TypeScript + Ant Design + TailwindCSS
- 后端：Express + Prisma + MySQL
- 测试执行：Playwright

## 目录

```text
frontend/  前端项目
backend/   后端项目
开发文档.md 设计文档
```

## 启动后端

```powershell
cd C:\workspace\e2e-platform\backend
npm install
copy .env.example .env
```

第一次初始化数据库，或修改了 `backend/prisma/schema.prisma` 后执行：

```powershell
npm run prisma:migrate
npm run prisma:generate
```

平时启动后端只需要：

```powershell
npm run dev
```

后端地址：

```text
http://localhost:3001
```

## 启动前端

```powershell
cd C:\workspace\e2e-platform\frontend
npm install
npm run dev
```

前端地址：

```text
http://localhost:5173
```

## 运行生成的 Playwright 用例

生成的自动化用例统一放在：

```text
backend/tests/generated
```

运行所有生成用例：

```powershell
cd C:\workspace\e2e-platform\backend
npm run test:generated
```

有界面运行：

```powershell
npm run test:generated:headed
```

打开 Playwright UI：

```powershell
npm run test:generated:ui
```

后端接口触发单个用例运行时，会调用：

```powershell
npm run test:generated -- --grep <用例id>
```

## 注意

- 启动前请确认 MySQL 已运行，并按需修改 `backend/.env` 中的 `DATABASE_URL`。
- 平时启动不需要执行 `prisma:migrate`，只有初始化数据库或改表结构时才需要。
- 初版 AI agent 会生成默认 Playwright 脚本，后续可替换为真实 agent。
