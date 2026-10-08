/**
 * 内容脚本引导（经典脚本，必须是最小体积）
 *
 * manifest 的 content_scripts 不支持 ESM，所以这里只做一件事：
 * 把真正的模块 src/content/app.js 动态 import 进来。
 * 这样 app.js 就能直接复用 core/ 下的调度、存储逻辑，
 * 与 service worker、popup、设置页共享同一份代码，不会出现三份实现。
 */

(() => {
  const url = chrome.runtime.getURL('src/content/app.js');
  import(url)
    .then((mod) => mod.start())
    .catch((err) => {
      // 加载失败不能影响宿主页面，只在控制台留个线索，方便排查
      console.warn('[语滴 Lingo Sip] 内容脚本加载失败：', err);
    });
})();
