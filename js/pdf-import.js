// Local-only PDF text extraction. Fixed layout, illustrations and OCR are not retained.
import { chaptersToEpubBlob, sectionPageMap } from './txt2epub.js'
import { assembleRows, rowsToParas, splitColumnFlows } from './reflow.js'
import { checkAbort } from './coop.js'
export async function pdfToReadingBook(file, { signal, onProgress } = {}) {
    checkAbort(signal)
    const {getDocument,GlobalWorkerOptions}=await import('../vendor/foliate-js/vendor/pdfjs/pdf.mjs')
    const base=new URL('../vendor/foliate-js/vendor/pdfjs/',import.meta.url)
    GlobalWorkerOptions.workerSrc=new URL('pdf.worker.mjs',base).href
    const task=getDocument({data:new Uint8Array(await file.arrayBuffer()),cMapUrl:new URL('cmaps/',base).href,cMapPacked:true,standardFontDataUrl:new URL('standard_fonts/',base).href,isEvalSupported:false})
    let pdf
    try {
        pdf=await task.promise
        if(pdf.numPages>1500)throw new Error('PDF 超过1500页，请拆分后导入')
        const chapters=[];let count=0,empty=0
        for(let n=1;n<=pdf.numPages;n++){
            // 每页一个让步点：用户取消在这里生效；task.destroy 在 finally 兜底清理 pdf.js 资源
            checkAbort(signal)
            const page=await pdf.getPage(n),content=await page.getTextContent()
            onProgress?.({ stage: '读取 PDF', done: n, total: pdf.numPages })
            // 先聚合成物理行（保留左右边界坐标），再拆开「正文+标题」并排的双流页
            // （不拆会出现「办哪27.怀孕和生产些证？」这类串行），最后按段距、缩进与
            // 短句末行重组段落，避免窄列 PDF 的每行被当成一段（「基础定律」拆开）。
            const text=rowsToParas(splitColumnFlows(assembleRows(content.items)));count+=text.join('').length
            if(count>10000000)throw new Error('PDF 文字超过1000万字，请拆分后导入')
            if(!text.length){empty++;text.push('（本页没有可提取的文字，可能是图片、扫描页或空白页，请查看原 PDF。）')}
            // pdfPage 记下这一章来自原 PDF 的第几页：段落数超过上限时 txt2epub 会把一页
            // 拆成多个 section，section 序号就不再等于页号（见 sectionPageMap）。
            chapters.push({title:`第 ${n} 页`,paragraphs:text,pdfPage:n});page.cleanup()
        }
        if(!count)throw new Error('这个 PDF 没有可提取的文字，可能是扫描件。请先用 OCR 转为含文字的 PDF 或 TXT')
        const meta=await pdf.getMetadata().catch(()=>null)
        const title=meta?.info?.Title?.trim()||file.name.replace(/\.pdf$/i,'')
        return {title,author:meta?.info?.Author||'',format:'pdf',data:await chaptersToEpubBlob(chapters,title,'',{cooperative:true,signal}),
            pdfTextOnly:true,pdfEmptyPages:empty,pdfPages:sectionPageMap(chapters),pdfPageCount:pdf.numPages}
    }catch(error){
        if(error.name==='PasswordException')throw new Error('此 PDF 需要密码，请先在本机解锁后再导入')
        if(error.name==='InvalidPDFException')throw new Error('PDF 文件损坏或格式无效')
        throw error
    }finally{await task.destroy()}
}
