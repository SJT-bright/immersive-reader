// Decode before persistence. Uploaded video is always muted and remains local.
export const isVideo = data => data?.type?.startsWith('video/')
export async function loadBackgroundVideo(url) {
    const video = document.createElement('video')
    video.muted = true; video.defaultMuted = true; video.loop = true; video.playsInline = true
    video.preload = 'auto'; video.setAttribute('aria-hidden', 'true')
    try {
        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => done(new Error('视频加载超时，请使用较小的 MP4 或 WebM')), 12000)
            const done = error => { clearTimeout(timer);video.onloadeddata=null;video.onerror=null;error?reject(error):resolve() }
            video.onloadeddata = () => done()
            video.onerror = () => done(new Error('视频无法解码，请使用 MP4（H.264）或 WebM'))
            video.src = url; video.load()
        })
        if (!video.videoWidth || !video.videoHeight) throw new Error('视频没有有效画面')
        return video
    } catch (error) { releaseVideo(video);throw error }
}
export function releaseVideo(video) { video.pause();video.removeAttribute('src');video.load();video.remove() }
export async function validateBackground(file) {
    const types = {jpg:'image/jpeg',jpeg:'image/jpeg',png:'image/png',webp:'image/webp',mp4:'video/mp4',webm:'video/webm',mov:'video/quicktime'}
    const type = file.type || types[file.name.split('.').pop().toLowerCase()]
    if (!Object.values(types).includes(type)) throw new Error('请选择 JPG、PNG、WebP、MP4、WebM 或 MOV')
    const video = type.startsWith('video/'), limit = (video ? 600 : 60) * 1024 * 1024
    if (!file.size || file.size > limit) throw new Error(video ? '视频须在 600MB 以内' : '图片须在 60MB 以内')
    const data = file.type === type ? file : new Blob([file], {type})
    if (video) {
        const url = URL.createObjectURL(data)
        try {
            const decoded = await loadBackgroundVideo(url)
            const pixels = decoded.videoWidth * decoded.videoHeight
            releaseVideo(decoded)
            if (pixels > 6144 * 3456) throw new Error('视频最高支持 6K，请压缩后重试')
        } finally { URL.revokeObjectURL(url) }
    } else {
        const image = await createImageBitmap(data), pixels = image.width * image.height
        image.close()
        if (pixels > 60000000) throw new Error('图片尺寸过大')
    }
    return data
}
