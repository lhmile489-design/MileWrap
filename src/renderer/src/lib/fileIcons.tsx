import {
  File,
  FileArchive,
  FileAudio,
  FileC,
  FileCode,
  FileCpp,
  FileCSharp,
  FileCss,
  FileCsv,
  FileDoc,
  FileHtml,
  FileImage,
  FileIni,
  FileJs,
  FileJsx,
  FileLock,
  FileMd,
  FilePdf,
  FilePpt,
  FilePy,
  FileRs,
  FileSql,
  FileSvg,
  FileTs,
  FileTsx,
  FileTxt,
  FileVideo,
  FileVue,
  FileXls,
  FileZip,
  Folder,
  FolderOpen,
  LinkSimple,
  type Icon
} from '@phosphor-icons/react'

/** 目录栏文件类型图标（PRD D-03）：按扩展名区分，统一 16px、单色 */
const BY_EXT: Record<string, Icon> = {
  ts: FileTs, mts: FileTs, cts: FileTs, tsx: FileTsx,
  js: FileJs, mjs: FileJs, cjs: FileJs, jsx: FileJsx,
  css: FileCss, scss: FileCss, less: FileCss,
  html: FileHtml, htm: FileHtml,
  py: FilePy, rs: FileRs, vue: FileVue, sql: FileSql,
  c: FileC, h: FileC, cpp: FileCpp, cc: FileCpp, hpp: FileCpp, cs: FileCSharp,
  java: FileCode, kt: FileCode, go: FileCode, rb: FileCode, php: FileCode, swift: FileCode, dart: FileCode,
  sh: FileCode, ps1: FileCode, bat: FileCode, cmd: FileCode,
  md: FileMd, mdx: FileMd, txt: FileTxt, log: FileTxt,
  json: FileIni, jsonc: FileIni, yaml: FileIni, yml: FileIni, toml: FileIni, ini: FileIni, xml: FileIni,
  properties: FileIni, env: FileIni, config: FileIni,
  lock: FileLock,
  png: FileImage, jpg: FileImage, jpeg: FileImage, gif: FileImage, webp: FileImage, ico: FileImage, bmp: FileImage,
  svg: FileSvg,
  zip: FileZip, '7z': FileZip, rar: FileZip, gz: FileZip, tar: FileArchive, tgz: FileArchive,
  pdf: FilePdf, csv: FileCsv, doc: FileDoc, docx: FileDoc, xls: FileXls, xlsx: FileXls, ppt: FilePpt, pptx: FilePpt,
  mp4: FileVideo, mov: FileVideo, webm: FileVideo, mp3: FileAudio, wav: FileAudio, flac: FileAudio
}

const BY_NAME: Record<string, Icon> = {
  'package-lock.json': FileLock,
  'yarn.lock': FileLock,
  'pnpm-lock.yaml': FileLock,
  '.gitignore': FileIni,
  '.npmrc': FileIni,
  '.editorconfig': FileIni,
  dockerfile: FileCode,
  makefile: FileCode
}

export function fileIcon(name: string, kind: 'dir' | 'file', open: boolean, link: boolean): Icon {
  if (link) return LinkSimple
  if (kind === 'dir') return open ? FolderOpen : Folder
  const lower = name.toLowerCase()
  const named = BY_NAME[lower]
  if (named) return named
  if (lower.startsWith('.env')) return FileIni
  const dot = lower.lastIndexOf('.')
  return (dot > 0 && BY_EXT[lower.slice(dot + 1)]) || File
}

/** 默认显示但灰化的目录 / 文件（UI设计约束 §4.1.1）：生成物与依赖，通常不是 agent 改动的对象 */
const DIMMED = new Set(['.git', 'node_modules', 'out', 'dist', 'build', 'release', '.next', '.nuxt', '.cache', 'target', '__pycache__', '.venv', 'venv'])

export function isDimmed(name: string): boolean {
  return DIMMED.has(name.toLowerCase())
}
