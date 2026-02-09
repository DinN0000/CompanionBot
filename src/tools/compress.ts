/**
 * Tool result compression utilities
 */

import { TOOL_RESULT_MAX_LENGTH } from "../utils/constants.js";

/**
 * 검색 결과 압축 - 상위 N개만 유지
 */
function compressSearchResults(result: string, maxResults: number = 5): string {
  const lines = result.split('\n');
  const headerMatch = lines[0]?.match(/^Search results for "(.+)":/);
  
  if (!headerMatch) {
    return result.slice(0, TOOL_RESULT_MAX_LENGTH);
  }
  
  // 결과 파싱 (번호로 구분)
  const results: string[] = [];
  let current = '';
  
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^\d+\.\s/.test(line) && current) {
      results.push(current.trim());
      current = line;
    } else {
      current += '\n' + line;
    }
  }
  if (current) results.push(current.trim());
  
  // 상위 N개만
  const truncated = results.slice(0, maxResults);
  const omitted = results.length - truncated.length;
  
  let output = lines[0] + '\n\n' + truncated.join('\n\n');
  if (omitted > 0) {
    output += `\n\n... (${omitted} more results omitted)`;
  }
  
  return output;
}

/**
 * 디렉토리 목록 압축
 */
function compressDirectoryListing(result: string, maxEntries: number = 50): string {
  const lines = result.split('\n').filter(l => l.trim());
  
  if (lines.length <= maxEntries) {
    return result;
  }
  
  const folders = lines.filter(l => l.startsWith('📁'));
  const files = lines.filter(l => l.startsWith('📄'));
  
  // 폴더 전체 + 파일 일부
  const folderCount = folders.length;
  const maxFiles = maxEntries - folderCount;
  
  let output = `Total: ${folders.length} folders, ${files.length} files\n\n`;
  output += folders.join('\n');
  
  if (files.length > 0) {
    output += '\n';
    if (files.length <= maxFiles) {
      output += files.join('\n');
    } else {
      output += files.slice(0, Math.floor(maxFiles / 2)).join('\n');
      output += `\n... (${files.length - maxFiles} more files)\n`;
      output += files.slice(-Math.ceil(maxFiles / 2)).join('\n');
    }
  }
  
  return output;
}

/**
 * 파일 내용 압축
 */
function compressFileContent(result: string, maxLength: number): string {
  if (result.length <= maxLength) {
    return result;
  }
  
  const lines = result.split('\n');
  const totalLines = lines.length;
  
  // 앞부분 80% 유지
  let output = '';
  let currentLength = 0;
  const targetLength = maxLength * 0.8;
  
  for (const line of lines) {
    if (currentLength + line.length > targetLength) break;
    output += line + '\n';
    currentLength += line.length + 1;
  }
  
  const includedLines = output.split('\n').length - 1;
  output += `\n... (showing ${includedLines}/${totalLines} lines, ${result.length} total chars)`;
  
  return output;
}

/**
 * 세션 로그 압축
 */
function compressSessionLog(result: string, maxLength: number): string {
  if (result.length <= maxLength) {
    return result;
  }
  
  const lines = result.split('\n');
  
  // 헤더 (처음 4줄) 유지
  const header = lines.slice(0, 4).join('\n');
  const logLines = lines.slice(4);
  
  // 로그는 최근 것이 중요 - 끝부분 유지
  const remainingLength = maxLength - header.length - 50;
  let tailOutput = '';
  
  for (let i = logLines.length - 1; i >= 0; i--) {
    if (tailOutput.length + logLines[i].length > remainingLength) break;
    tailOutput = logLines[i] + '\n' + tailOutput;
  }
  
  const omittedLines = logLines.length - tailOutput.split('\n').filter(l => l).length;
  
  return `${header}\n... (${omittedLines} earlier lines omitted)\n${tailOutput}`;
}

/**
 * 도구별 스마트 결과 압축
 */
export function compressToolResult(toolName: string, result: string): string {
  const maxLength = TOOL_RESULT_MAX_LENGTH;
  
  // 이미 짧으면 그대로
  if (result.length <= maxLength) {
    return result;
  }
  
  switch (toolName) {
    case "web_search":
      return compressSearchResults(result, 5);
    
    case "list_directory":
      return compressDirectoryListing(result, 50);
    
    case "read_file":
      return compressFileContent(result, maxLength);
    
    case "get_session_log":
      return compressSessionLog(result, maxLength);
    
    case "memory_search":
      // 메모리 검색은 상위 결과만
      const memResults = result.split('\n\n---\n\n');
      if (memResults.length > 3) {
        return memResults.slice(0, 3).join('\n\n---\n\n') + 
               `\n\n... (${memResults.length - 3} more results)`;
      }
      return result.slice(0, maxLength) + "... (truncated)";
    
    default:
      // 기본: 단순 truncate
      return result.slice(0, maxLength) + "... (truncated)";
  }
}
