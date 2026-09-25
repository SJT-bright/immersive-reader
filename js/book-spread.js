// 双页书的一屏几何：两栏加中缝正好铺满这一屏，中缝中心落在书页中线。
// 栏宽取整后的余数加进中缝，避免多出一栏，也避免中缝偏到书缝的一侧。

export function spreadColumnMetrics(pageWidth) {
    const width = Math.max(160, Math.floor(Number(pageWidth) || 0))
    const outer = width < 520 ? 12 : 22
    let gutter = Math.max(width < 520 ? 28 : 44, Math.round(width * 0.05))
    let columnWidth = Math.floor((width - outer * 2 - gutter) / 2)
    if (columnWidth < 80) {
        gutter = Math.max(16, gutter - (80 - columnWidth) * 2)
        columnWidth = Math.floor((width - outer * 2 - gutter) / 2)
    }
    const slack = width - (columnWidth * 2 + gutter + outer * 2)
    gutter += slack
    return {
        pageWidth: width,
        outer,
        gutter,
        columnWidth,
        gapCenter: outer + columnWidth + gutter / 2,
    }
}
