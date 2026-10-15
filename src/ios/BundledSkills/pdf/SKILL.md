---
name: pdf
version: 1.0.0
description: 读取、拆分、合并、旋转、填写和生成 PDF；提取文字和表格，把页面渲染成图片检查版式。用户发来 PDF、要从 PDF 里找内容，或要求“做成 PDF”时使用。
---

# PDF

改编自 openai/skills 的 `pdf` 技能（Apache-2.0，见 LICENSE.txt）。改动：适配 LeoBot 内置的 Alpine Linux（用 apk 装依赖、文件路径、中文字体），补充了拆分、合并、填表的做法。

## 文件位置

- 用户发来的附件在 `/var/minis/attachments/uploads/`。
- 产出写到 `/var/minis/workspace/`，会自动出现在对话的产物栏里。**不要覆盖原件。**
- 中间文件放 `/tmp/pdfwork/`，交付后删掉。

## 第一次用时装依赖

```sh
python3 -c "import pypdf, pdfplumber, reportlab" 2>/dev/null && echo ready || {
  apk add --no-cache py3-reportlab poppler-utils >/dev/null
  python3 -m pip install --quiet pypdf pdfplumber
}
```

装不上就把报错原样告诉用户。`pdftoppm`（poppler-utils）只用于渲染检查，装不上也不影响读写。

## 读

- 提取文字和表格用 `pdfplumber`：`page.extract_text()`、`page.extract_tables()`。适合找内容，不保证还原版式。
- 页数多时先看目录和前几页，按需读，别把整本塞进对话。
- **扫描件**（`extract_text()` 几乎为空）没有文字层：把页面渲染成图片，用 `read_image` 看图识字，并告诉用户这是看图识别、可能有错字。
- 加密的 PDF：`pypdf.PdfReader(path).is_encrypted` 为真时，问用户要密码，不要猜。

## 改

用 `pypdf`：

- 合并：`w = PdfWriter(); w.append("a.pdf"); w.append("b.pdf"); w.write(out)`
- 拆出某几页：`w.add_page(reader.pages[i])`
- 旋转：`page.rotate(90)`
- 填表单：`reader.get_fields()` 先看字段名，再 `w.update_page_form_field_values(w.pages[0], {"字段名": "值"})`
- 加密码：`w.encrypt(user_password)`

## 生成

用 `reportlab`。中文必须注册内置的 CJK 字体，否则全是方块：

```python
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.cidfonts import UnicodeCIDFont
pdfmetrics.registerFont(UnicodeCIDFont("STSong-Light"))   # 宋体,无需字体文件
styles["Normal"].fontName = "STSong-Light"
```

表格的 `TableStyle` 里也要给 `FONTNAME` 指定同一个字体。版面要求高的报告，可以先用 frontend-design 技能做成网页，再告诉用户可在 Safari 里“打印 → 存储为 PDF”。

## 检查

生成或修改后，把关键页渲染成图片自己看一遍：

```sh
mkdir -p /tmp/pdfwork && pdftoppm -png -r 80 -f 1 -l 2 输出.pdf /tmp/pdfwork/page
```

再用 `read_image` 看 `/tmp/pdfwork/page-1.png`。检查文字有没有方块、表格有没有错位、有没有被截断。没装 poppler 时，至少用 `pdfplumber` 读回文字核对。

## 交付

回复里说清楚输出文件名、页数，以及哪些内容是看图识别的、需要用户核对。
