/**
 * UIスプリッターの初期化
 * 左右スプリッター（sidebar と chatPane の間）のドラッグによるリサイズを制御します。
 * ※ 上下スプリッターはリスト統合 (DEC-024) に伴い廃止されました。
 */
export function initSplitters(): void {
  const sidebar = document.getElementById('appSidebar') as HTMLElement;
  const mainSplitter = document.getElementById('mainSplitter') as HTMLElement;

  if (!sidebar || !mainSplitter) {
    console.warn('Splitter elements not found, skipping splitter initialization.');
    return;
  }

  mainSplitter.addEventListener('mousedown', (e) => {
    e.preventDefault();
    document.body.classList.add('resizing-h');
    mainSplitter.classList.add('resizing');

    const startX = e.clientX;
    const startWidth = sidebar.getBoundingClientRect().width;

    const onMouseMove = (moveEvent: MouseEvent) => {
      const deltaX = moveEvent.clientX - startX;
      // 最小幅 220px, 最大幅 600px に制限
      const newWidth = Math.max(220, Math.min(600, startWidth + deltaX));
      sidebar.style.width = `${newWidth}px`;
    };

    const onMouseUp = () => {
      document.body.classList.remove('resizing-h');
      mainSplitter.classList.remove('resizing');
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  });
}
