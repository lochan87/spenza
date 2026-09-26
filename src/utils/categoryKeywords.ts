/**
 * Smart categorization keywords.
 * Maps description keywords → category names.
 * Extend this freely — it's the single place to add new auto-suggestions.
 */

export const CATEGORY_KEYWORDS: Record<string, string> = {
  // Food & Drinks
  'chai':       'Food & Drinks',
  'coffee':     'Food & Drinks',
  'tea':        'Food & Drinks',
  'food':       'Food & Drinks',
  'lunch':      'Food & Drinks',
  'dinner':     'Food & Drinks',
  'breakfast':  'Food & Drinks',
  'snack':      'Food & Drinks',
  'swiggy':     'Food & Drinks',
  'zomato':     'Food & Drinks',
  'restaurant': 'Food & Drinks',
  'dosa':       'Food & Drinks',
  'biryani':    'Food & Drinks',
  'juice':      'Food & Drinks',
  'ice cream':  'Food & Drinks',
  'pizza':      'Food & Drinks',
  'burger':     'Food & Drinks',
  'bread':      'Food & Drinks',
  'milk':       'Food & Drinks',
  'groceries':  'Food & Drinks',
  'grocery':    'Food & Drinks',
  'vegetables': 'Food & Drinks',
  'fruits':     'Food & Drinks',
  'eggs':       'Food & Drinks',

  // Transport
  'metro':      'Transport',
  'bus':        'Transport',
  'auto':       'Transport',
  'rickshaw':   'Transport',
  'cab':        'Transport',
  'ola':        'Transport',
  'uber':       'Transport',
  'rapido':     'Transport',
  'petrol':     'Transport',
  'fuel':       'Transport',
  'diesel':     'Transport',
  'parking':    'Transport',
  'toll':       'Transport',
  'train':      'Transport',
  'railway':    'Transport',
  'ticket':     'Transport',

  // Shopping
  'amazon':     'Shopping',
  'flipkart':   'Shopping',
  'myntra':     'Shopping',
  'clothes':    'Shopping',
  'shirt':      'Shopping',
  'shoes':      'Shopping',
  'jeans':      'Shopping',
  'bag':        'Shopping',
  'accessories': 'Shopping',
  'market':     'Shopping',

  // Gifts & Events
  'gift':       'Gifts & Events',
  'birthday':   'Gifts & Events',
  'wedding':    'Gifts & Events',
  'party':      'Gifts & Events',
  'flowers':    'Gifts & Events',
  'celebration': 'Gifts & Events',
  'anniversary': 'Gifts & Events',
  'present':    'Gifts & Events',

  // Health
  'doctor':     'Health',
  'hospital':   'Health',
  'medicine':   'Health',
  'pharmacy':   'Health',
  'dental':     'Health',
  'clove':      'Health',
  'clinic':     'Health',
  'medical':    'Health',
  'gym':        'Health',
  'fitness':    'Health',
  'vitamins':   'Health',
  'chemist':    'Health',

  // Education
  'course':     'Education',
  'udemy':      'Education',
  'coursera':   'Education',
  'books':      'Education',
  'textbook':   'Education',
  'stationery': 'Education',
  'print':      'Education',
  'xerox':      'Education',
  'tuition':    'Education',
  'class':      'Education',
  'exam':       'Education',

  // Travel
  'hotel':      'Travel',
  'flight':     'Travel',
  'makemytrip': 'Travel',
  'goibibo':    'Travel',
  'trip':       'Travel',
  'vacation':   'Travel',
  'tour':       'Travel',
  'hostel':     'Travel',
  'resort':     'Travel',

  // Bills & Recharge
  'mobile':     'Bills & Recharge',
  'recharge':   'Bills & Recharge',
  'electricity': 'Bills & Recharge',
  'bill':       'Bills & Recharge',
  'internet':   'Bills & Recharge',
  'broadband':  'Bills & Recharge',
  'wifi':       'Bills & Recharge',
  'jio':        'Bills & Recharge',
  'vodafone':   'Bills & Recharge',
  'bsnl':       'Bills & Recharge',
  'airtel':     'Bills & Recharge',
  'dth':        'Bills & Recharge',
  'gas':        'Bills & Recharge',
  'water':      'Bills & Recharge',
  'maintenance': 'Bills & Recharge',

  // Entertainment
  'movie':      'Entertainment',
  'cinema':     'Entertainment',
  'netflix':    'Entertainment',
  'hotstar':    'Entertainment',
  'prime':      'Entertainment',
  'spotify':    'Entertainment',
  'game':       'Entertainment',
  'gaming':     'Entertainment',
  'concert':    'Entertainment',
  'event':      'Entertainment',
  'show':       'Entertainment',
  'theatre':    'Entertainment',

  // Personal/Household
  'rent':       'Personal/Household',
  'household':  'Personal/Household',
  'cleaning':   'Personal/Household',
  'laundry':    'Personal/Household',
  'haircut':    'Personal/Household',
  'salon':      'Personal/Household',
  'barber':     'Personal/Household',
  'toiletries': 'Personal/Household',
  'soap':       'Personal/Household',
  'shampoo':    'Personal/Household',
}

/**
 * Returns a suggested category name based on the description, or null if no match.
 * Case-insensitive keyword matching.
 */
export function suggestCategory(description: string): string | null {
  const lower = description.toLowerCase()
  for (const [keyword, category] of Object.entries(CATEGORY_KEYWORDS)) {
    if (lower.includes(keyword)) {
      return category
    }
  }
  return null
}
