"""make-test-xlsx.py —— 生成一个最小的真实 XLSX（不依赖 openpyxl）

用来测试 static/js/xlsx.js 的读取与 hotspot-map.js 的匹配。
"""

import zipfile
import os
import sys

CT = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>
</Types>"""

RELS = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>"""

WB = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
 xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="检验点" sheetId="1" r:id="rId1"/></sheets>
</workbook>"""

WB_RELS = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>
</Relationships>"""


def col(i):
    s = ""
    n = i
    while True:
        s = chr(65 + n % 26) + s
        n = n // 26 - 1
        if n < 0:
            break
    return s


def build(rows, out):
    """rows: 二维数组，字符串走 sharedStrings，数字直接内联"""
    strings = []
    index = {}

    def sid(s):
        if s not in index:
            index[s] = len(strings)
            strings.append(s)
        return index[s]

    sheet_rows = []
    for r, row in enumerate(rows, start=1):
        cells = []
        for c, v in enumerate(row):
            if v is None or v == "":
                continue
            ref = f"{col(c)}{r}"
            if isinstance(v, (int, float)) and not isinstance(v, bool):
                cells.append(f'<c r="{ref}"><v>{v}</v></c>')
            else:
                cells.append(f'<c r="{ref}" t="s"><v>{sid(str(v))}</v></c>')
        sheet_rows.append(f'<row r="{r}">{"".join(cells)}</row>')

    sheet = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
        f'<sheetData>{"".join(sheet_rows)}</sheetData></worksheet>'
    )

    sst = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        f'<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
        f'count="{len(strings)}" uniqueCount="{len(strings)}">'
        + "".join(f"<si><t>{s}</t></si>" for s in strings)
        + "</sst>"
    )

    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", CT)
        z.writestr("_rels/.rels", RELS)
        z.writestr("xl/workbook.xml", WB)
        z.writestr("xl/_rels/workbook.xml.rels", WB_RELS)
        z.writestr("xl/sharedStrings.xml", sst)
        z.writestr("xl/worksheets/sheet1.xml", sheet)
    print(f"写入 {out}: {len(rows)} 行, {len(strings)} 个字符串")


if __name__ == "__main__":
    out = sys.argv[1] if len(sys.argv) > 1 else r"D:\JT\webjt\_test\分组表.xlsx"

    # 故意混入真实场景的噪声：
    #  · 名称前缀序号（000_）、JT 尾缀（_612）
    #  · 大小写不一致、多余空格
    #  · 同组多行（一个零件多个检验点）
    #  · 一行匹配不上的错别字
    rows = [
        ["序号", "零件名称", "检验项目", "数量", "备注"],
        ["1", "BaseSameAsMaster", "外观无划伤", 1, "全检"],
        ["2", "000_midhousing", "配合尺寸 φ10H7", 2, "抽检"],
        ["3", "Elbow", "角度 90°±0.5", 4, ""],
        ["4", "elbow", "内壁毛刺", 4, "去毛刺"],
        ["5", "HEATER", "绝缘电阻 ≥100MΩ", 1, "安全件"],
        ["6", "U_Bracket_612", "孔位度", 2, ""],
        ["7", "tophousing", "平面度 0.05", 1, ""],
        ["8", "bushing", "内径 φ6+0.02", 8, "关键尺寸"],
        ["9", "bushing", "外径 φ10-0.01", 8, "关键尺寸"],
        ["10", "screw", "扭矩 2.5N·m", 10, ""],
        ["11", "coffee_pot", "容量 1.2L", 1, ""],
        ["12", "PowerCord", "耐压 1500V", 1, "安全件"],
        ["13", "name_plate", "字迹清晰", 1, ""],
        ["14", "push_fastener", "插拔力", 3, ""],
        ["15", "不存在的零件XYZ", "应为未匹配行", 1, "测试"],
    ]
    build(rows, out)
