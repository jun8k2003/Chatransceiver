/**
 * UIスプリッターの初期化
 * 左右スプリッター（sidebar と chatPane の間）と
 * 上下スプリッター（個別チャット userPane とグループチャット groupPane の間）の
 * ドラッグによるリサイズを制御します。
 */
export function initSplitters(): void {
  const sidebar = document.getElementById('appSidebar') as HTMLElement;
  const mainSplitter = document.getElementById('mainSplitter') as HTMLElement;
  const userPane = document.getElementById('userPane') as HTMLElement;
  const sidebarSplitter = document.getElementById('sidebarSplitter') as HTMLElement;

  if (!sidebar || !mainSplitter || !userPane || !sidebarSplitter) {
    console.warn('Splitter elements not found, skipping splitter initialization.');
    return;
  }

  // 1. 左右スプリッター (Horizontal Splitter)
  mainSplitter.addEventListener('mousedown', (e) => {
    e.preventDefault();
    document.body.classList.add('resizing-h');
    mainSplitter.classList.add('resizing');

    const startX = e.clientX;
    const startWidth = sidebar.getBoundingClientRect().width;

    const onMouseMove = (moveEvent: MouseEvent) => {
      const deltaX = moveEvent.clientX - startX;
      // 最小幅 180px, 最大幅 600px に制限
      const newWidth = Math.max(180, Math.min(600, startWidth + deltaX));
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

  // 2. 上下スプリッター (Vertical Splitter)
  sidebarSplitter.addEventListener('mousedown', (e) => {
    e.preventDefault();
    document.body.classList.add('resizing-v');
    sidebarSplitter.classList.add('resizing');

    const startY = e.clientY;
    const startHeight = userPane.getBoundingClientRect().height;

    const onMouseMove = (moveEvent: MouseEvent) => {
      const deltaY = moveEvent.clientY - startY;
      const parentHeight = sidebar.getBoundingClientRect().height;
      
      // 個別チャット、グループチャットともに最小高さ 100px に制限
      const newHeight = Math.max(100, Math.min(parentHeight - 100, startHeight + deltaY));
      userPane.style.height = `${newHeight}px`;
    };

    const onMouseUp = () => {
      document.body.classList.remove('resizing-v');
      sidebarSplitter.classList.remove('resizing');
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  });
}
