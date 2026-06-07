/**
 * 現在の実行環境がPWA（スタンドアロンモード）であるかを判定する
 * @returns PWAとして起動されている場合はtrue
 */
export function isRunningAsPWA(): boolean {
  // Android (Chrome) などの標準仕様判定
  const isStandaloneDisplay = window.matchMedia('(display-mode: standalone)').matches;
  
  // iOS (Safari) 用の互換判定
  const isIOSStandalone = (window.navigator as any).standalone === true;
  
  return isStandaloneDisplay || isIOSStandalone;
}
