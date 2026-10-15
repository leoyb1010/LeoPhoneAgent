---
name: leo-office
version: 1.0.0
description: 读写 Word（.docx）、Excel（.xlsx）、PowerPoint（.pptx）文件：提取内容、改文字和表格、填表、生成新文档或简单幻灯片。用户发来或提到这三类文件、或要求“做成 Word / Excel / PPT”时使用。不处理 .doc / .xls / .ppt 旧格式和 PDF（PDF 用 pdf 技能）。
---

# Office 文档（Word / Excel / PPT）

在 LeoBot 内置的 Linux 里用纯 Python 处理 Office 文件。这里没有 LibreOffice，也没有 Office，所以**不能渲染预览、不能重算公式、不能转 PDF**。需要这些时直接告诉用户，别假装做到了。

## 文件位置

- 用户发来的附件在 `/var/minis/attachments/uploads/`。
- 产出写到 `/var/minis/workspace/`。写在这里的新文件会自动出现在对话的产物栏里，用户可以直接打开或分享。
- **不要覆盖用户的原件**：改完另存为新文件名，例如 `合同_修改版.docx`。

## 第一次用时装依赖

先检查，缺了再装。apk 装的是预编译包，比 pip 快很多：

```sh
python3 -c "import docx, openpyxl, pptx" 2>/dev/null && echo ready || {
  apk add --no-cache py3-lxml py3-pillow py3-openpyxl >/dev/null
  python3 -m pip install --quiet python-docx python-pptx
}
```

装不上就把报错原样告诉用户，别反复重试。

## 先看清文件再动手

```sh
python3 /var/minis/skills/leo-office/scripts/office_inspect.py 文件路径
```

它会打印段落、样式、表格（Word），工作表、尺寸、表头、公式数量（Excel），每页标题和文字（PPT）。改之前先看一遍，改完再跑一遍核对。

## Word（python-docx）

- 读：`Document(path).paragraphs`、`.tables`。页眉页脚在 `doc.sections[i].header`。
- **改字保留格式**：一段文字常被拆成多个 run。只替换整段时，把第一个 run 的 `text` 改成新内容、清空其余 run，格式就保留在第一个 run 上。不要直接给 `paragraph.text` 赋值，那会丢掉所有格式。
- 中文字体要同时设东亚字体，否则显示成默认字体：

```python
from docx.oxml.ns import qn
run.font.name = "宋体"
run._element.rPr.rFonts.set(qn("w:eastAsia"), "宋体")
```

- 不支持修订模式（Track Changes）和批注的写入。用户要“留痕修改”时，说明做不到，改成在新文件里用加粗或颜色标出改动。

## Excel（openpyxl）

- 读取值：`load_workbook(path, data_only=True)`。注意 `data_only=True` 读到的是**上次 Excel 保存时缓存的值**；文件如果是程序生成、从没被 Excel 打开过，公式单元格会是 `None`，要说明这一点。
- 要改文件时用 `data_only=False` 打开，否则保存后公式全变成固定值。
- 写公式就写字符串：`ws["D2"] = "=B2*C2"`。openpyxl **不会计算**，用户在 Excel 或 Numbers 里打开时才会算出结果，回答时说清楚。
- 大表格先用 `ws.max_row`、`ws.max_column` 看尺寸，只打印前几行，别把整张表塞进对话。
- 需要统计分析或出图时，交给 data-analyze 技能（pandas），这里只负责读写文件本身。

## PowerPoint（python-pptx）

- 新建：`Presentation()`，版式 0 是标题页，1 是标题加正文。中文正文把字号定在 18–24pt，一页不超过 6 行。
- 改已有文件：遍历 `prs.slides` 里每个 `shape.has_text_frame` 的段落，改法和 Word 一样，替换第一个 run 的文字。
- 图片：`slide.shapes.add_picture(path, left, top, width=...)`。
- 做不出复杂动画和设计感很强的模板。用户要“好看的演示”时，建议改做成网页幻灯片（frontend-design 技能），或者先交一版结构清楚的 PPT。

## 交付

1. 保存到 `/var/minis/workspace/`，文件名写清楚内容。
2. 再跑一次 `office_inspect.py` 核对：段落或单元格数量对得上，没有乱码。
3. 回复里说清楚改了哪些地方，以及哪些需要用户在 Office 里确认（公式结果、版式、字体）。
