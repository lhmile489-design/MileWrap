/**
 * 识别色板（PRD W-13 分组色点、升级建议 4.5 格头色带）：只用于区分，不承载状态。
 * 色点旁边总有分组名 / 会话名，颜色不是唯一的信息来源。
 */
export const GROUP_COLORS: { label: string; value: string | null }[] = [
  { label: '不设颜色', value: null },
  { label: '红', value: '#dc2626' },
  { label: '橙', value: '#ea580c' },
  { label: '黄', value: '#ca8a04' },
  { label: '绿', value: '#16a34a' },
  { label: '青', value: '#0891b2' },
  { label: '蓝', value: '#2563eb' },
  { label: '紫', value: '#9333ea' },
  { label: '灰', value: '#64748b' }
]
