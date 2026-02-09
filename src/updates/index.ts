/**
 * 업데이트 체크 모듈
 * npm 레지스트리에서 최신 버전을 확인합니다.
 * @module updates
 */

import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

/**
 * 업데이트 정보
 */
interface UpdateInfo {
  /** 현재 설치된 버전 */
  current: string;
  /** npm 레지스트리의 최신 버전 */
  latest: string;
  /** 업데이트 가능 여부 */
  hasUpdate: boolean;
}

/**
 * 현재 설치된 버전을 반환합니다.
 * @returns 현재 버전 문자열 (예: "0.6.0")
 */
export function getCurrentVersion(): string {
  // package.json에서 버전 읽기
  return require("../../package.json").version;
}

/**
 * npm 레지스트리에서 최신 버전을 확인합니다.
 * @returns 업데이트 정보 (현재 버전, 최신 버전, 업데이트 가능 여부)
 */
export async function checkForUpdates(): Promise<UpdateInfo> {
  const current = getCurrentVersion();
  
  try {
    const { stdout } = await execAsync("npm view companionbot version");
    const latest = stdout.trim();
    
    return {
      current,
      latest,
      hasUpdate: latest !== current && compareVersions(latest, current) > 0
    };
  } catch {
    return { current, latest: current, hasUpdate: false };
  }
}

/**
 * 두 semver 버전을 비교합니다.
 * @param a - 첫 번째 버전
 * @param b - 두 번째 버전
 * @returns a > b면 1, a < b면 -1, 같으면 0
 */
function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] > pb[i]) return 1;
    if (pa[i] < pb[i]) return -1;
  }
  return 0;
}
