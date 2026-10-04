export type Recipe = {
  day: number;
  name: string;
  note: string;
  ingredients: string[];
  coachNote: string;
};

export const recipes: Recipe[] = [
  {
    day: 1,
    name: "Berry Green",
    note: "Source note: Sun / Mon",
    ingredients: [
      "3 handfuls spinach",
      "2 cups water",
      "1 apple, cored and quartered",
      "1 cup frozen mangoes",
      "1 cup frozen strawberries",
      "1 handful frozen or fresh seedless grapes",
      "1 stevia packet (more if needed)",
      "2 tablespoons ground flaxseeds",
      "Optional: 1 scoop protein powder"
    ],
    coachNote: "Make the day easier before it starts: prep the full batch in the morning and portion it for later."
  },
  {
    day: 2,
    name: "Apple Strawberry",
    note: "Source note: Mon / Tues",
    ingredients: [
      "3 handfuls spring mix greens",
      "2 cups water",
      "1 banana, peeled",
      "2 apples, cored and quartered",
      "1½ cups frozen strawberries",
      "2 stevia packets (more if needed)",
      "2 tablespoons ground flaxseeds",
      "Optional: 1 scoop protein powder"
    ],
    coachNote: "Keep your routine simple today: recipe first, then divide the blended batch into three portions."
  },
  {
    day: 3,
    name: "Apple Berry",
    note: "Source note: Tues / Wed",
    ingredients: [
      "1 handful spring mix greens",
      "2 handfuls spinach",
      "2 cups water",
      "1½ cups frozen blueberries",
      "1 banana, peeled",
      "1 apple, cored and quartered",
      "1 stevia packet",
      "2 tablespoons ground flaxseeds",
      "Optional: 1 scoop protein powder"
    ],
    coachNote: "A steady rhythm is enough—sip or space servings about three to four hours apart as the source suggests."
  },
  {
    day: 4,
    name: "Berry Peachy",
    note: "Source note: Wed / Thur",
    ingredients: [
      "2 handfuls kale",
      "1 handful spinach",
      "2 cups water",
      "2 apples, cored and quartered",
      "1½ cups frozen peaches",
      "1½ cups frozen mixed berries",
      "2 stevia packets",
      "2 tablespoons ground flaxseeds",
      "Optional: 1 scoop protein powder"
    ],
    coachNote: "With a smaller blender, split the recipe into batches—the source says that is completely fine."
  },
  {
    day: 5,
    name: "Peach Berry Spinach",
    note: "Source note: Thurs / Fri",
    ingredients: [
      "3 handfuls spinach",
      "2 cups water",
      "1 cup frozen peaches",
      "1 handful fresh or frozen seedless grapes",
      "1½ cups blueberries",
      "3 stevia packets to sweeten",
      "2 tablespoons ground flaxseeds",
      "Optional: 1 scoop protein powder"
    ],
    coachNote: "Pause for a quick check-in: notice what has made your setup feel easier so far."
  },
  {
    day: 6,
    name: "Pineapple Spinach",
    note: "Source note: Fri / Sat",
    ingredients: [
      "2 cups fresh spinach, packed",
      "1 cup pineapple chunks",
      "2 cups frozen peaches",
      "2 bananas, peeled",
      "1½ packets stevia",
      "2 cups water",
      "2 tablespoons ground flaxseeds",
      "Optional: 1 scoop protein powder"
    ],
    coachNote: "A fresh container and an early prep moment can make the second half of the program feel lighter."
  },
  {
    day: 7,
    name: "Pineapple Berry",
    note: "Source note: Sat / Sun",
    ingredients: [
      "2 handfuls spring mix greens",
      "2 handfuls spinach",
      "1 banana, peeled",
      "1½ cups pineapple chunks",
      "1½ cups frozen mango chunks",
      "1 cup frozen mixed berries",
      "3 packets stevia",
      "2 cups water",
      "2 tablespoons ground flaxseeds",
      "Optional: 1 scoop protein powder"
    ],
    coachNote: "Keep the basics visible—water, prepared portions, and a simple snack option for when hunger arrives."
  },
  {
    day: 8,
    name: "Spinach Kale Berry",
    note: "Source note: Sun / Mon",
    ingredients: [
      "2 handfuls kale",
      "2 handfuls spinach",
      "2 cups water",
      "1 apple, cored and quartered",
      "1 banana, peeled",
      "1½ cups frozen blueberries",
      "2 packets stevia",
      "2 tablespoons ground flaxseeds",
      "Optional: 1 scoop protein powder"
    ],
    coachNote: "Your daily aim can stay small and tangible: blend, refrigerate, sip, and check in with yourself."
  },
  {
    day: 9,
    name: "Apple Mango",
    note: "Source note: Mon / Tues",
    ingredients: [
      "3 handfuls spinach",
      "2 cups water",
      "1 apple, cored and quartered",
      "1½ cups mangoes",
      "2 cups frozen strawberries",
      "1 packet stevia",
      "2 tablespoons ground flaxseeds",
      "Optional: 1 scoop protein powder"
    ],
    coachNote: "One day at a time is still the plan—use the preparation steps as a gentle reset, not a test."
  },
  {
    day: 10,
    name: "Pineapple Kale",
    note: "Source note: Tues / Wed",
    ingredients: [
      "2 handfuls kale",
      "1 handful spring mix greens",
      "2 cups water",
      "1½ cups frozen peaches",
      "2 handfuls pineapple chunks",
      "2 packets stevia",
      "2 tablespoons ground flaxseeds",
      "Optional: 1 scoop protein powder"
    ],
    coachNote: "Finish with the same kind of care you began with: a prepared batch, a clear next step, and a kind reflection."
  }
];

export const standardDirections = [
  "Place leafy greens and water into the blender.",
  "Blend until the mixture looks green and juice-like.",
  "Stop the blender, add the remaining ingredients, and blend until creamy.",
  "With a smaller blender, divide the recipe and blend in batches."
];

export const snacks = [
  "Apple slices",
  "Celery, carrots, cucumbers, or other crunchy vegetables",
  "Unsweetened peanut butter",
  "Hard-boiled eggs",
  "A handful of raw or unsalted nuts and seeds"
];

export const avoidList = [
  "Refined / white sugar",
  "Meat or red meat",
  "Milk and cheese",
  "Liquor and beer",
  "Coffee, sodas, and diet sodas",
  "Processed and fried foods",
  "Refined carbohydrates such as white bread, pasta, and donuts"
];

export const phasePrep = [
  {
    label: "Days 1–5 · Berry & orchard",
    days: "Berry Green through Peach Berry Spinach",
    items: [
      "Leafy greens: spinach, spring mix, and kale",
      "Fruit: apples, mangoes, strawberries, grapes, blueberries, peaches, and mixed berries",
      "Pantry: water, stevia packets, ground flaxseeds, and optional protein powder",
      "Set aside containers for a morning-made, refrigerated day batch"
    ]
  },
  {
    label: "Days 6–10 · Tropical finish",
    days: "Pineapple Spinach through Pineapple Kale",
    items: [
      "Leafy greens: spinach, spring mix, and kale",
      "Fruit: pineapple, peaches, bananas, mangoes, apples, strawberries, blueberries, and mixed berries",
      "Pantry: water, stevia packets, ground flaxseeds, and optional protein powder",
      "Choose a backup snack from the source list before leaving home"
    ]
  }
];
