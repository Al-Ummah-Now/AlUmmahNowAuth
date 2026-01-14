/**
 * Formats a date value that can be either an ISO string or Unix timestamp
 * @param dateValue - ISO string or Unix timestamp (in seconds)
 * @returns Formatted date string
 */
export function formatDate(dateValue: string | number): string {
  const date = typeof dateValue === 'number'
    ? new Date(dateValue * 1000)  // Unix seconds to ms
    : new Date(dateValue);
  return date.toLocaleDateString();
}
