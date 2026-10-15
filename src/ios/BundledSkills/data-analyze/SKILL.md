---
name: data-analyze
version: 1.0.0
description: 分析 CSV、Excel 等表格数据：回答“这份数据说明了什么”、找趋势和异常、分组对比、算指标，并出图。用户发来数据文件、贴出一张表，或问“帮我分析一下这些数据”时使用。只读写文件本身请用 leo-office。
---

# 数据分析

工作流程参考 anthropics/knowledge-work-plugins 的 data 插件（Apache-2.0，见 LICENSE.txt），改写为在 LeoBot 内置 Linux 里用 pandas 分析本地文件。

## 文件位置

- 附件在 `/var/minis/attachments/uploads/`；产出（图表、清洗后的表）写到 `/var/minis/workspace/`。
- 写到 workspace 的图片会直接显示在对话里，不用再调用别的工具。

## 第一次用时装依赖

```sh
python3 -c "import pandas, matplotlib" 2>/dev/null && echo ready || \
  apk add --no-cache py3-pandas py3-matplotlib py3-openpyxl >/dev/null
```

图里要显示中文时再装字体（只装一次）：

```sh
fc-list | grep -qi "zen hei" || apk add --no-cache font-wqy-zenhei >/dev/null
```

```python
import matplotlib
matplotlib.rcParams["font.sans-serif"] = ["WenQuanYi Zen Hei", "DejaVu Sans"]
matplotlib.rcParams["axes.unicode_minus"] = False
```

字体装不上就用英文标签，别交出满是方块的图。

## 流程

### 1. 先弄清问题

判断用户要的是哪一种：

- **一个数**：“上个月卖了多少？”直接给数字和计算口径。
- **一次分析**：“为什么下降了？”拆成几个子问题，逐个回答。
- **一份报告**：结论、方法、发现、注意事项、建议。

问题含糊时，先根据数据猜一个最可能的意思，说明这个假设，再往下做。

### 2. 读数据

```python
import pandas as pd
df = pd.read_csv(path)            # 中文 CSV 乱码时试 encoding="gbk"
# df = pd.read_excel(path, sheet_name=None)   # 多个工作表时先看有哪些
print(df.shape); print(df.dtypes); print(df.head())
```

大表只打印形状、字段和前几行，不要把整张表输出到对话里。

### 3. 分析前先核对

- **行数**：和用户说的、和常识对得上吗？
- **空值**：哪些列缺得多，会不会影响结论？
- **数量级**：金额、比例有没有明显离谱的值？
- **时间**：日期列有没有断档、格式混用？
- **汇总**：分项加起来等于总数吗？

发现问题先说出来，再决定是清洗、剔除还是带着注意事项继续。

### 4. 分析

按问题选方法：分组汇总（`groupby`）、同比环比、占比、排名、透视表（`pivot_table`）、相关性。只做和问题相关的，别为了显得全面堆指标。

### 5. 出图（有帮助时才出）

- 趋势用折线，对比用柱状，构成用堆叠柱或少量分类的饼图，分布用直方图。
- 一张图只讲一件事；标题写结论（“3 月起转化率下滑”），不写“转化率图”。
- 保存：`plt.savefig("/var/minis/workspace/xxx.png", dpi=150, bbox_inches="tight")`。

### 6. 回答

- **先说结论**，再给支撑的数字和图。
- 写清口径和计算方式，方便用户自己复核。
- 说明局限：样本少、缺数据、相关不等于因果。
- 最后给一两个值得继续看的问题。
