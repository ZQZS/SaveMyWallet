export function normalizedText(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/\s+/gu, '')
}

function normalizedPlatform(value: string): string {
  return normalizedText(value)
    .replace(/bilibili|哔哩哔哩/gu, 'b站')
    .replace(/^jd(?=$|白条)/u, '京东')
}

const shortPlatformNames: Record<string, string> = {
  'b站会员购': 'b站',
  '支付宝花呗': '花呗',
  '京东白条': '白条',
}

export function matchesPlatformName(name: string, hint: string): boolean {
  const label = normalizedPlatform(name)
  const query = normalizedPlatform(hint)
  return query.length > 0 && (label.includes(query) || shortPlatformNames[query] === label)
}
