import './style.css';
import { App } from './app';
import { initSplitters } from './ui/splitter';

// moduleスクリプトはDOMの解析後に実行されるため、そのまま初期化
const app = new App();
app.init();
initSplitters();
