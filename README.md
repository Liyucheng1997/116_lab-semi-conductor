# 半导体器件三维可视化 (Semiconductor Visualizer)

基于 Three.js + TypeScript + Vite 构建的交互式三维教学工具，用于直观展示常见半导体器件的内部结构、偏置状态与载流子流动。

## 功能特性

- **五种器件**：PN 二极管、NPN 三极管、PNP 三极管、N 沟道 MOSFET、P 沟道 MOSFET
- **三种工作模式**：形成（结构构建）、阻断（反偏/截止）、导通（正偏/开启）
- **三维可视化**：可旋转/缩放的 3D 场景，区分 P 型区、N 型区、金属电极、氧化层、耗尽层、固定离子、电子与空穴
- **动态载流子**：实时动画展示电子与空穴的扩散与漂移
- **电流曲线**：交互式偏置滑块，实时绘制并标注器件的电流-电压特性曲线
- **原理讲解**：每种器件配有工作原理与要点说明

## 技术栈

- [Three.js](https://threejs.org/) — WebGL 三维渲染
- TypeScript
- [Vite](https://vitejs.dev/) — 开发与构建工具

## 快速开始

```bash
# 安装依赖
npm install

# 启动开发服务器
npm run dev

# 构建生产版本
npm run build

# 预览构建结果
npm run preview
```

开发服务器默认运行在 http://127.0.0.1:5173

## 项目结构

```
├── index.html          # 页面入口与控制面板
├── src/
│   ├── main.ts         # 核心逻辑：场景、器件构建、动画、曲线
│   └── styles.css      # 样式
├── verification/       # 各器件/模式的渲染验证截图
├── vite.config.ts
└── tsconfig.json
```

## 截图

`verification/` 目录包含各器件在不同模式下的渲染截图，可作为效果参考。

## 许可

MIT License
