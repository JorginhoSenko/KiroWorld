# 基洛世界地图台 · KiroWorld Atlas

给架空世界创作者用的**可长期使用**的地理地图编辑器。以真实地球海陆为底图，
可以在任意经纬度加岛、改岸线、删陆块，并把结果存档 / 导出。

## 启动

需要通过本地 HTTP 服务器访问（不能直接双击 `index.html`，否则无法读取底图数据）。

```powershell
# 在项目根目录执行
& $env:MIMO_PYTHON -m http.server 8765 --bind 127.0.0.1
# 然后浏览器打开 http://127.0.0.1:8765/
```

任何静态服务器都可以，例如 `npx serve`、VS Code Live Server 等。

## 它能做什么

| 需求 | 怎么做 |
| --- | --- |
| 在大洋洲添一个小岛 | 右侧「经纬度定位」填 `150` / `-22`，点「在此造岛…」，调半径 (km) |
| 在图上随手造岛 | 左侧「造岛」工具，在图上按下并拖出半径，松开即生成 |
| 手绘一块大陆 | 左侧「手绘」工具，逐点点击，回车 / 双击闭合 |
| 改岸线 | 「选择」工具点中陆块 → 拖动顶点；双击边插入顶点；右键或 Alt 删除顶点 |
| 删掉一块地 | 「擦除」工具点一下；或选中后按 Delete / 点「删除陆块」 |
| 隐藏原始地球 | 左侧「底图」开关（可做出完全架空的世界） |
| 保存 / 再次编辑 | 顶部「保存」导出 `.kiroworld.json`，下次「打开」即可继续 |
| 出图 | 顶部 `PNG`（当前视野位图）、`SVG`（矢量）、`GeoJSON`（全部陆地坐标） |

## 快捷键

- `V` 选择 · `H` 平移 · `I` 造岛 · `D` 手绘 · `E` 擦除
- `Space` + 拖动 = 临时平移
- 滚轮缩放（以光标为中心）
- `Esc` 取消正在画的图形
- `Enter` 闭合手绘多边形
- `Delete` 删除选中陆块 / 光标下的顶点

## 数据说明

- 底图：Natural Earth 1:50m land（经 `world-atlas` TopoJSON 解码为 1419 块独立陆地）。
- 投影：等距圆柱（Plate Carrée），1 度 = 恒定像素，方便按经纬度量算。
- 每块陆地（含原始底图）都是独立要素，可以单独选中、改名、改顶点、删除。
- 用户改动只保存「差异」：删了哪些底图陆块、改了哪些、新增了哪些。底图本身不重复存档，
  所以项目文件很小。

## 目录

```
index.html          页面骨架
css/style.css       界面样式
js/app.js           全部逻辑（渲染 / 编辑 / 存档导出）
data/land.geojson   解码后的底图（1419 个多边形）
data/land-50m.json  原始 TopoJSON
tools/topo2geo.py   TopoJSON → GeoJSON 转换脚本
```

重新生成底图：

```powershell
& $env:MIMO_PYTHON tools/topo2geo.py data/land-50m.json data/land.geojson
```

## 技术形态

纯静态 HTML / CSS / JS（ES module），无构建步骤、无第三方运行时依赖。
Canvas 2D 渲染，localStorage 自动暂存最近一次改动（打开页面会询问恢复）。
