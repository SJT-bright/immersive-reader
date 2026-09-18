// Local-only PDF text extraction. Fixed layout, illustrations and OCR are not retained.
import { chaptersToEpubBlob } from './txt2epub.js?v=1.5.0'
import { assembleRows, rowsToParas } from './reflow.js?v=1.0.0'
export async function pdfToReadingBook(file) {
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
            const page=await pdf.getPage(n),content=await page.getTextContent()
            // 先聚合成物理行（保留左右边界坐标），再按「满行+无句末标点=硬换行」
            // 重组段落，避免窄列 PDF 的每行被当成一段（「基础定律」拆成「基/础定律」）。
            const text=rowsToParas(assembleRows(content.items));count+=text.join('').length
            if(count>10000000)throw new Error('PDF 文字超过1000万字，请拆分后导入')
            if(!text.length){empty++;text.push('（本页没有可提取的文字，可能是图片、扫描页或空白页，请查看原 PDF。）')}
            chapters.push({title:`第 ${n} 页`,paragraphs:text});page.cleanup()
        }
        if(!count)throw new Error('这个 PDF 没有可提取的文字，可能是扫描件。请先用 OCR 转为含文字的 PDF 或 TXT')
        const meta=await pdf.getMetadata().catch(()=>null)
        const title=meta?.info?.Title?.trim()||file.name.replace(/\.pdf$/i,'')
        return {title,author:meta?.info?.Author||'',format:'pdf',data:await chaptersToEpubBlob(chapters,title),pdfTextOnly:true,pdfEmptyPages:empty}
    }catch(error){
        if(error.name==='PasswordException')throw new Error('此 PDF 需要密码，请先在本机解锁后再导入')
        if(error.name==='InvalidPDFException')throw new Error('PDF 文件损坏或格式无效')
        throw error
    }finally{await task.destroy()}
}
