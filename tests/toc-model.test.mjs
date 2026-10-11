import test from 'node:test'
import assert from 'node:assert/strict'
import { directoryModel, currentDirectoryKey, directoryMatches, pageWindow, savedDirectoryModel, directoryCache } from '../js/toc-model.js'
const make = () => ({ sections: [{id:'a'},{id:'b'}], splitTOCHref: href => href.split('#'), toc: [
    {label:'前言',href:'a#start',subitems:[{label:'怎么读',href:'a#how'},{label:'四种资源',href:'a#types'}]},
    {label:'第二章',href:'b'}] })
test('同一正文段的多个锚点只有一行拥有页数/进度，每个小节仍有独立目标', () => {
    const book = make(), model = directoryModel(book)
    assert.equal(directoryModel(book),model)
    assert.deepEqual(model.entries.map(e=>e.statistics),[true,false,false,true])
    assert.equal(currentDirectoryKey(model,{section:0,href:'a#types',label:'四种资源'}),2)
    assert.equal(currentDirectoryKey(model,{section:0}),0)
    assert.equal(currentDirectoryKey(model,{section:99}),-1)
})
test('筛选保留匹配小节的父项，命中数不包含上下文行', () => {
    const model=directoryModel(make()), result=directoryMatches(model.entries,'四种')
    assert.deepEqual([...result.visible].sort(),[0,2])
    assert.equal(result.count,1)
    assert.equal(directoryMatches(model.entries,'不存在').visible.size,0)
})
test('未知目录地址不伪造已读统计，重复标签按 href 区分', () => {
    const book=make();book.toc.push({label:'四种资源',href:'missing#x'})
    const model=directoryModel(book)
    assert.equal(model.entries.at(-1).index,-1)
    assert.equal(model.entries.at(-1).statistics,false)
    assert.equal(currentDirectoryKey(model,{section:0,href:'a#types'}),2)
})
test('一万页展开最多80个页码且尾页始终可访问', () => {
    assert.equal(pageWindow(10000).pages.length,80)
    assert.deepEqual(pageWindow(10000,9991).pages,[9991,9992,9993,9994,9995,9996,9997,9998,9999,10000])
    assert.deepEqual(pageWindow(0).pages,[])
})


test('持久化目录与实时目录使用同一正文统计归属和父子关系', () => {
    const entries=directoryModel(make()).entries.map(({label,href,index,depth})=>({label,href,index,depth}))
    const model=savedDirectoryModel(entries)
    assert.deepEqual(model.entries.map(e=>e.statistics),[true,false,false,true])
    assert.deepEqual(model.entries.map(e=>e.parent),[-1,0,0,-1])
})

test('超过缓存预算的目录不占用进度写盘容量，正常774项逐字保留', () => {
    const normal=Array.from({length:774},(_,index)=>({label:'章节'+index,href:'a#'+index,index,depth:0}))
    assert.equal(directoryCache(normal),normal)
    const large=Array.from({length:10000},(_,index)=>({label:'目录'.repeat(512),href:'a#'+index,index,depth:0}))
    assert.equal(directoryCache(large),null)
})
