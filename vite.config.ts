import { defineConfig } from 'vite';
import fs from 'fs';
import path from 'path';

// ビルド番号を自動でインクリメントして環境変数に注入するプラグイン
function buildCounterPlugin() {
  return {
    name: 'build-counter',
    config(config, { command }) {
      let buildNumber: number | string = 1;
      
      // 1. GitHub Actions環境の場合は、通算の実行番号(GITHUB_RUN_NUMBER)を優先する
      if (process.env.GITHUB_RUN_NUMBER) {
        buildNumber = `CI-${process.env.GITHUB_RUN_NUMBER}`;
      } else {
        // 2. ローカル環境の場合は build_number.txt を使用する
        const counterFile = path.resolve(process.cwd(), 'build_number.txt');
        
        // 既存のカウンターを読み込み
        if (fs.existsSync(counterFile)) {
          buildNumber = parseInt(fs.readFileSync(counterFile, 'utf-8'), 10) || 1;
        }
        
        // buildコマンドの時だけインクリメントして保存
        if (command === 'build') {
          buildNumber = (buildNumber as number) + 1;
          fs.writeFileSync(counterFile, buildNumber.toString(), 'utf-8');
        }
      }

      // ソースコード内で使えるグローバル定数として注入
      return {
        define: {
          __BUILD_NUMBER__: JSON.stringify(buildNumber),
          __BUILD_TIME__: JSON.stringify(new Date().toLocaleString('ja-JP'))
        }
      };
    }
  };
}

export default defineConfig({
  plugins: [buildCounterPlugin()]
});
