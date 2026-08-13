#!/usr/bin/env python3

from __future__ import annotations

import html
import sys
import zipfile
from dataclasses import dataclass, field
from html.parser import HTMLParser
from pathlib import Path
from xml.sax.saxutils import escape


ROOT = Path(__file__).resolve().parent
SOURCE = ROOT / 'CLIENT_STATUS_UPDATE.html'
OUTPUT = ROOT / 'CLIENT_STATUS_UPDATE.docx'


@dataclass
class Node:
    tag: str
    attrs: dict[str, str] = field(default_factory=dict)
    children: list[Node | str] = field(default_factory=list)

    def text(self) -> str:
        value = ''.join(child if isinstance(child, str) else child.text() for child in self.children)
        return ' '.join(html.unescape(value).split())


class TreeParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.root = Node('root')
        self.stack = [self.root]

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        node = Node(tag, {name: value or '' for name, value in attrs})
        self.stack[-1].children.append(node)
        if tag not in {'meta', 'link', 'br', 'hr', 'img', 'input'}:
            self.stack.append(node)

    def handle_startendtag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        self.handle_starttag(tag, attrs)
        if self.stack[-1].tag == tag:
            self.stack.pop()

    def handle_endtag(self, tag: str) -> None:
        for index in range(len(self.stack) - 1, 0, -1):
            if self.stack[index].tag == tag:
                del self.stack[index:]
                return

    def handle_data(self, data: str) -> None:
        self.stack[-1].children.append(data)


def run(text: str, *, bold: bool = False, color: str | None = None, size: int | None = None) -> str:
    properties = []
    if bold:
        properties.append('<w:b/>')
    if color:
        properties.append(f'<w:color w:val="{color}"/>')
    if size:
        properties.append(f'<w:sz w:val="{size}"/><w:szCs w:val="{size}"/>')
    properties_xml = f'<w:rPr>{"".join(properties)}</w:rPr>' if properties else ''
    return f'<w:r>{properties_xml}<w:t xml:space="preserve">{escape(text)}</w:t></w:r>'


def paragraph(
    text: str,
    *,
    style: str | None = None,
    bold: bool = False,
    color: str | None = None,
    size: int | None = None,
    before: int = 0,
    after: int = 120,
    indent: int = 0,
    shading: str | None = None,
    border: str | None = None,
) -> str:
    props = []
    if style:
        props.append(f'<w:pStyle w:val="{style}"/>')
    props.append(f'<w:spacing w:before="{before}" w:after="{after}" w:line="330" w:lineRule="auto"/>')
    if indent:
        props.append(f'<w:ind w:left="{indent}" w:hanging="240"/>')
    if shading:
        props.append(f'<w:shd w:val="clear" w:color="auto" w:fill="{shading}"/>')
    if border:
        props.append(f'<w:pBdr><w:left w:val="single" w:sz="24" w:space="8" w:color="{border}"/></w:pBdr>')
    return f'<w:p><w:pPr>{"".join(props)}</w:pPr>{run(text, bold=bold, color=color, size=size)}</w:p>'


def table(node: Node) -> str:
    rows = [child for child in node.children if isinstance(child, Node) and child.tag == 'tr']
    if not rows:
        containers = [child for child in node.children if isinstance(child, Node) and child.tag in {'thead', 'tbody'}]
        rows = [row for container in containers for row in container.children if isinstance(row, Node) and row.tag == 'tr']
    column_count = max((len([cell for cell in row.children if isinstance(cell, Node) and cell.tag in {'th', 'td'}]) for row in rows), default=1)
    widths = {
        3: [2500, 1700, 5200],
        4: [2500, 1900, 1800, 3200],
    }.get(column_count, [int(9400 / column_count)] * column_count)
    grid = ''.join(f'<w:gridCol w:w="{width}"/>' for width in widths)
    output = [
        '<w:tbl>',
        '<w:tblPr><w:tblW w:w="0" w:type="auto"/><w:tblLayout w:type="fixed"/>',
        '<w:tblBorders><w:top w:val="single" w:sz="4" w:color="B8C6CC"/>'
        '<w:left w:val="single" w:sz="4" w:color="B8C6CC"/>'
        '<w:bottom w:val="single" w:sz="4" w:color="B8C6CC"/>'
        '<w:right w:val="single" w:sz="4" w:color="B8C6CC"/>'
        '<w:insideH w:val="single" w:sz="4" w:color="B8C6CC"/>'
        '<w:insideV w:val="single" w:sz="4" w:color="B8C6CC"/></w:tblBorders></w:tblPr>',
        f'<w:tblGrid>{grid}</w:tblGrid>',
    ]
    for row_index, row in enumerate(rows):
        cells = [cell for cell in row.children if isinstance(cell, Node) and cell.tag in {'th', 'td'}]
        output.append('<w:tr>')
        if row_index == 0:
            output.append('<w:trPr><w:tblHeader/></w:trPr>')
        for index, cell in enumerate(cells):
            fill = 'DFEFF2' if row_index == 0 or cell.tag == 'th' else 'FFFFFF'
            cell_width = widths[index] if index < len(widths) else widths[-1]
            text = cell.text()
            output.append(
                f'<w:tc><w:tcPr><w:tcW w:w="{cell_width}" w:type="dxa"/>'
                f'<w:shd w:val="clear" w:color="auto" w:fill="{fill}"/>'
                '<w:vAlign w:val="top"/></w:tcPr>'
                f'{paragraph(text, bold=row_index == 0 or cell.tag == "th", size=19, after=40)}'
                '</w:tc>'
            )
        output.append('</w:tr>')
    output.append('</w:tbl>')
    output.append(paragraph('', after=80))
    return ''.join(output)


def render_body(body: Node) -> str:
    output: list[str] = []
    for child in body.children:
        if not isinstance(child, Node):
            continue
        text = child.text()
        if child.tag == 'h1':
            output.append(paragraph(text, style='Title', color='123A52', size=34, before=0, after=80))
        elif child.tag == 'h2':
            output.append(paragraph(text, style='Heading1', color='175C72', size=27, before=260, after=90))
        elif child.tag == 'h3':
            output.append(paragraph(text, style='Heading2', color='274C5B', size=23, before=180, after=70))
        elif child.tag == 'p' and child.attrs.get('class') == 'meta':
            output.append(paragraph(text, color='64748B', size=18, after=180))
        elif child.tag == 'p':
            output.append(paragraph(text, size=20))
        elif child.tag == 'div' and child.attrs.get('class') == 'summary':
            output.append(paragraph(text, size=20, shading='EEF7F8', border='27869A', before=80, after=160))
        elif child.tag == 'div' and child.attrs.get('class') == 'warning':
            output.append(paragraph(text, size=20, shading='FFF8E7', border='D59B2D', before=80, after=160))
        elif child.tag in {'ul', 'ol'}:
            items = [item for item in child.children if isinstance(item, Node) and item.tag == 'li']
            for index, item in enumerate(items, start=1):
                marker = f'{index}.' if child.tag == 'ol' else '•'
                output.append(paragraph(f'{marker} {item.text()}', size=20, indent=480, after=65))
        elif child.tag == 'table':
            output.append(table(child))
    return ''.join(output)


def package(document_xml: str) -> None:
    content_types = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>'''
    relationships = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>'''
    document_relationships = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>'''
    styles = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Aptos" w:hAnsi="Aptos" w:eastAsia="Microsoft YaHei"/><w:lang w:val="en-US" w:eastAsia="zh-CN"/></w:rPr></w:rPrDefault></w:docDefaults>
  <w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
  <w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:qFormat/></w:style>
  <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:outlineLvl w:val="0"/><w:qFormat/></w:style>
  <w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:outlineLvl w:val="1"/><w:qFormat/></w:style>
</w:styles>'''
    with zipfile.ZipFile(OUTPUT, 'w', zipfile.ZIP_DEFLATED) as archive:
        archive.writestr('[Content_Types].xml', content_types)
        archive.writestr('_rels/.rels', relationships)
        archive.writestr('word/document.xml', document_xml)
        archive.writestr('word/styles.xml', styles)
        archive.writestr('word/_rels/document.xml.rels', document_relationships)


def main() -> None:
    parser = TreeParser()
    parser.feed(SOURCE.read_text(encoding='utf-8'))
    html_nodes = [node for node in parser.root.children if isinstance(node, Node) and node.tag == 'html']
    if len(html_nodes) != 1:
        raise RuntimeError('Expected one html root')
    body_nodes = [node for node in html_nodes[0].children if isinstance(node, Node) and node.tag == 'body']
    if len(body_nodes) != 1:
        raise RuntimeError('Expected one body')
    body_xml = render_body(body_nodes[0])
    document = f'''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>{body_xml}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="900" w:right="720" w:bottom="900" w:left="720" w:header="360" w:footer="360" w:gutter="0"/></w:sectPr></w:body>
</w:document>'''
    package(document)
    print(f'Generated {OUTPUT}')


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(f'Generation failed: {error}', file=sys.stderr)
        raise
