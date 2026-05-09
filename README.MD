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

```bash
cd backend
npm install
cp .env.example .env
```

修改了 `backend/prisma/schema.prisma` 后执行：

```bash
npm run prisma:generate
```

数据库表会在后端启动时按 `backend/sql/init.sql` 自动初始化。平时启动后端只需要：

```bash
npm run dev
```

后端地址：

```text
http://localhost:3001
```

## 启动前端

```bash
cd frontend
npm install
npm run dev
```

前端地址：

```text
http://localhost:5173
```

## Docker 部署

Docker 部署会把前端静态资源、后端 API、Claude Code CLI 和 Playwright 浏览器打包到同一个容器里，数据库仍使用外部 MySQL。

镜像基于 `node:22-bookworm-slim` 构建，运行阶段只安装生产依赖和 Chromium，避免把源码、开发依赖和本地运行产物打进最终镜像。

构建镜像：

```bash
docker build -t e2e-platform .
```

如果 npm registry 访问不稳定，可以在构建时指定镜像源：

```bash
docker build \
  --build-arg NPM_REGISTRY=https://registry.npmmirror.com \
  -t e2e-platform .
```

准备运行环境变量：

```bash
cp deploy.env.example deploy.env
```

请在 `deploy.env` 中填写 `DATABASE_URL`，以及 Claude Code 使用 deepseek-v4-flash 所需的非密钥类环境变量。镜像不会内置任何密钥。

`ANTHROPIC_AUTH_TOKEN` 不写入 `deploy.env`，部署时通过 `docker run -e` 单独传入，避免密钥被误复制或误提交。

如果 MySQL 也是 Docker 容器，推荐把两个容器加入同一个网络，并在 `DATABASE_URL` 里使用 MySQL 容器名，例如：

```env
DATABASE_URL=mysql://root:your_password@e2e-mysql:3306/e2e_platform
```

注意：`docker run --env-file` 不会自动去掉变量值外层的双引号，`deploy.env` 里不要写成 `DATABASE_URL="mysql://..."`。

启动容器：

```bash
docker run -d \
  --name e2e-platform \
  --restart unless-stopped \
  --network e2e-net \
  -p 9099:9099 \
  --env-file ./deploy.env \
  -e ANTHROPIC_AUTH_TOKEN=your-token \
  e2e-platform
```

如果容器需要访问宿主机上的 MySQL 或被测系统，Linux 环境可以加上：

```bash
--add-host=host.docker.internal:host-gateway
```

部署后访问：

```text
http://localhost:9099
```

容器启动时会由后端自动执行 `sql/init.sql` 初始化数据库表，然后启动 Web 服务。

## 运行生成的 Playwright 用例

生成的自动化用例统一放在：

```text
backend/tests/generated
```

运行所有生成用例：

```bash
cd backend
npm run test:generated
```

有界面运行：

```bash
npm run test:generated:headed
```

打开 Playwright UI：

```bash
npm run test:generated:ui
```

后端接口触发单个用例运行时，会调用：

```bash
npm run test:generated -- tests/generated/<用例id>.spec.ts
```

## 注意

- 启动前请确认 MySQL 已运行，并按需修改 `backend/.env` 中的 `DATABASE_URL`。
- 平时启动不需要手动建表；空库会在后端启动时自动创建当前版本需要的表。
- 如果修改了表结构，需要同步更新 `backend/prisma/schema.prisma` 和 `backend/sql/init.sql`。
- 生成的脚本和运行结果在 `backend/tests/generated`、`backend/test-results` 下，属于运行产物，不需要提交仓库。
