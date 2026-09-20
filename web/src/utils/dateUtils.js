/**
 * Date Utility Module for Asia/Taipei Timezone
 */

/**
 * Get YYYY-MM-DD date string strictly in Asia/Taipei timezone.
 * @param {Date|string|number} [d=new Date()]
 * @returns {string} Date string formatted as YYYY-MM-DD
 */
export function getTaipeiYMD(d = new Date()) {
  const dateObj = typeof d === 'string' || typeof d === 'number' ? new Date(d) : d
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Taipei' }).format(dateObj)
}
