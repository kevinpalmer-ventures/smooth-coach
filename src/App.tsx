import { useEffect, useMemo, useRef, useState } from "react";
import { avoidList, phasePrep, recipes, snacks, standardDirections } from "./cleanseData";

type View = "today" | "program" | "recipes" | "prep" | "progress";
type PlanMode = "full" | "modified";

type DayEntry = {
  tasks: string[];
  water: number;
  reflection: string;
};

type CoachState = {
  activeDay: number;
  planMode: PlanMode;
  days: Record<number, DayEntry>;
  reminders: boolean;
};

type RoutineTask = {
  id: string;
  eyebrow: string;
  title: string;
  detail: string;
};

const STORAGE_KEY = "smooth-coach-state-v1";
const emptyEntry: DayEntry = { tasks: [], water: 0, reflection: "" };

const navItems: { id: View; label: string; mark: string }[] = [
  { id: "today", label: "Today", mark: "◐" },
  { id: "program", label: "Program", mark: "10" },
  { id: "recipes", label: "Recipes", mark: "✦" },
  { id: "prep", label: "Prep notes", mark: "⌁" },
  { id: "progress", label: "Progress", mark: "↗" }
];

function makeDefaultState(): CoachState {
  return { activeDay: 1, planMode: "full", days: {}, reminders: false };
}

function loadState(): CoachState {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (!stored) return makeDefaultState();
    const parsed = JSON.parse(stored) as Partial<CoachState>;
    return {
      activeDay: Math.min(10, Math.max(1, Number(parsed.activeDay) || 1)),
      planMode: parsed.planMode === "modified" ? "modified" : "full",
      days: parsed.days ?? {},
      reminders: Boolean(parsed.reminders)
    };
  } catch {
    return makeDefaultState();
  }
}

function getTasks(mode: PlanMode): RoutineTask[] {
  const smoothie = "Use one portion of today’s blended batch — about 12–16 oz.";
  if (mode === "modified") {
    return [
      {
        id: "prep",
        eyebrow: "Start here",
        title: "Prepare today’s smoothie batch",
        detail: "Blend greens with water first, then blend in the remaining ingredients. Refrigerate portions when possible."
      },
      { id: "morning", eyebrow: "Morning", title: "Breakfast smoothie", detail: smoothie },
      { id: "midday", eyebrow: "Midday", title: "Lunch smoothie", detail: smoothie },
      {
        id: "evening",
        eyebrow: "Evening",
        title: "One healthy dinner",
        detail: "The source suggests a salad or sautéed vegetables with grilled or baked fish or chicken. It also says any two meals may be smoothies."
      }
    ];
  }
  return [
    {
      id: "prep",
      eyebrow: "Start here",
      title: "Prepare today’s smoothie batch",
      detail: "Blend greens with water first, then blend in the remaining ingredients. Refrigerate portions when possible."
    },
    { id: "morning", eyebrow: "Morning", title: "Breakfast smoothie", detail: smoothie },
    { id: "midday", eyebrow: "Midday", title: "Lunch smoothie", detail: smoothie },
    { id: "evening", eyebrow: "Evening", title: "Dinner smoothie", detail: smoothie }
  ];
}

function dayEntry(state: CoachState, day: number): DayEntry {
  return state.days[day] ?? emptyEntry;
}

function completionFor(state: CoachState, day: number): number {
  const entry = dayEntry(state, day);
  const taskScore = getTasks(state.planMode).filter((task) => entry.tasks.includes(task.id)).length;
  const waterScore = entry.water >= 8 ? 1 : 0;
  return Math.round(((taskScore + waterScore) / 5) * 100);
}

function App() {
  const [state, setState] = useState<CoachState>(loadState);
  const [view, setView] = useState<View>("today");
  const [recipeSearch, setRecipeSearch] = useState("");
  const [reminderMessage, setReminderMessage] = useState("");
  const nudgeKey = useRef("");

  const activeRecipe = recipes[state.activeDay - 1];
  const activeEntry = dayEntry(state, state.activeDay);
  const routineTasks = getTasks(state.planMode);
  const activeCompletion = completionFor(state, state.activeDay);
  const completedDays = recipes.filter((recipe) => completionFor(state, recipe.day) === 100).length;
  const nextDay = recipes.find((recipe) => completionFor(state, recipe.day) < 100)?.day ?? 10;

  useEffect(() => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }, [state]);

  useEffect(() => {
    if (!state.reminders || !("Notification" in window) || Notification.permission !== "granted") return;

    const sendNudgeIfDue = () => {
      const now = new Date();
      const isNudgeTime = (now.getHours() === 9 || now.getHours() === 19) && now.getMinutes() === 0;
      const key = `${now.toDateString()}-${now.getHours()}`;
      if (!isNudgeTime || nudgeKey.current === key) return;
      nudgeKey.current = key;
      const body = now.getHours() === 9
        ? `Day ${state.activeDay}: prep ${activeRecipe.name} and set up your portions.`
        : `Day ${state.activeDay}: take a small moment to finish your check-in.`;
      new Notification("Smooth Coach", { body });
    };

    sendNudgeIfDue();
    const interval = window.setInterval(sendNudgeIfDue, 30000);
    return () => window.clearInterval(interval);
  }, [state.reminders, state.activeDay, activeRecipe.name]);

  const updateEntry = (day: number, transform: (entry: DayEntry) => DayEntry) => {
    setState((current) => ({
      ...current,
      days: { ...current.days, [day]: transform(dayEntry(current, day)) }
    }));
  };

  const toggleTask = (taskId: string) => {
    updateEntry(state.activeDay, (entry) => ({
      ...entry,
      tasks: entry.tasks.includes(taskId)
        ? entry.tasks.filter((item) => item !== taskId)
        : [...entry.tasks, taskId]
    }));
  };

  const setWater = (water: number) => {
    updateEntry(state.activeDay, (entry) => ({ ...entry, water: Math.min(8, Math.max(0, water)) }));
  };

  const setReflection = (reflection: string) => {
    updateEntry(state.activeDay, (entry) => ({ ...entry, reflection }));
  };

  const setActiveDay = (day: number, destination: View = "today") => {
    setState((current) => ({ ...current, activeDay: day }));
    setView(destination);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const completeDay = () => {
    updateEntry(state.activeDay, (entry) => ({
      ...entry,
      tasks: routineTasks.map((task) => task.id),
      water: 8
    }));
  };

  const handleReminderToggle = async () => {
    if (state.reminders) {
      setState((current) => ({ ...current, reminders: false }));
      setReminderMessage("Nudges are off. You can switch them on any time.");
      return;
    }
    if (!("Notification" in window)) {
      setReminderMessage("This browser does not support notifications. The daily guide still works normally.");
      return;
    }
    const result = await Notification.requestPermission();
    if (result === "granted") {
      setState((current) => ({ ...current, reminders: true }));
      setReminderMessage("Nudges are on for 9:00 and 19:00 while this app stays open.");
    } else {
      setReminderMessage("Notifications were not enabled. You can keep using the in-app daily guide.");
    }
  };

  const filteredRecipes = useMemo(() => {
    const query = recipeSearch.trim().toLowerCase();
    if (!query) return recipes;
    return recipes.filter((recipe) => `${recipe.name} ${recipe.ingredients.join(" ")}`.toLowerCase().includes(query));
  }, [recipeSearch]);

  return (
    <div className="app-shell">
      <aside className="sidebar" aria-label="Smooth Coach navigation">
        <button className="brand" onClick={() => setView("today")} aria-label="Smooth Coach home">
          <span className="brand-mark"><img src="/leaf-mark.svg" alt="" /></span>
          <span><b>Smooth</b> Coach</span>
        </button>

        <nav className="main-nav">
          {navItems.map((item) => (
            <button
              key={item.id}
              className={`nav-item ${view === item.id ? "active" : ""}`}
              onClick={() => setView(item.id)}
            >
              <span className="nav-mark">{item.mark}</span>
              {item.label}
            </button>
          ))}
        </nav>

        <div className="sidebar-footnote">
          <span className="tiny-leaf">⌇</span>
          <p>Ten days, one calmer next step.</p>
        </div>
      </aside>

      <main className="main-content">
        <header className="topbar">
          <div>
            <p className="eyebrow">10-day green smoothie guide</p>
            <h1>{view === "today" ? "Your daily ritual" : navItems.find((item) => item.id === view)?.label}</h1>
          </div>
          <div className="topbar-actions">
            <span className="day-chip">Day {state.activeDay} of 10</span>
            <button className="profile-button" aria-label="Personal guide settings">SC</button>
          </div>
        </header>

        <div className="mobile-nav" aria-label="Mobile navigation">
          {navItems.map((item) => (
            <button key={item.id} className={view === item.id ? "active" : ""} onClick={() => setView(item.id)}>
              <span>{item.mark}</span>{item.label}
            </button>
          ))}
        </div>

        {view === "today" && (
          <TodayView
            recipe={activeRecipe}
            activeDay={state.activeDay}
            planMode={state.planMode}
            setPlanMode={(planMode) => setState((current) => ({ ...current, planMode }))}
            tasks={routineTasks}
            completedTasks={activeEntry.tasks}
            onToggleTask={toggleTask}
            water={activeEntry.water}
            setWater={setWater}
            reflection={activeEntry.reflection}
            setReflection={setReflection}
            completion={activeCompletion}
            onCompleteDay={completeDay}
            onDaySelect={setActiveDay}
            onRecipeOpen={() => setActiveDay(state.activeDay, "recipes")}
            reminders={state.reminders}
            onReminderToggle={() => void handleReminderToggle()}
            reminderMessage={reminderMessage}
          />
        )}

        {view === "program" && (
          <ProgramView
            activeDay={state.activeDay}
            state={state}
            onDaySelect={setActiveDay}
          />
        )}

        {view === "recipes" && (
          <RecipesView
            activeDay={state.activeDay}
            search={recipeSearch}
            setSearch={setRecipeSearch}
            recipes={filteredRecipes}
            onDaySelect={setActiveDay}
          />
        )}

        {view === "prep" && <PrepView onRecipeClick={(day) => setActiveDay(day, "recipes")} />}

        {view === "progress" && (
          <ProgressView
            state={state}
            completedDays={completedDays}
            nextDay={nextDay}
            onDaySelect={setActiveDay}
          />
        )}
      </main>
    </div>
  );
}

function TodayView({
  recipe,
  activeDay,
  planMode,
  setPlanMode,
  tasks,
  completedTasks,
  onToggleTask,
  water,
  setWater,
  reflection,
  setReflection,
  completion,
  onCompleteDay,
  onDaySelect,
  onRecipeOpen,
  reminders,
  onReminderToggle,
  reminderMessage
}: {
  recipe: (typeof recipes)[number];
  activeDay: number;
  planMode: PlanMode;
  setPlanMode: (mode: PlanMode) => void;
  tasks: RoutineTask[];
  completedTasks: string[];
  onToggleTask: (taskId: string) => void;
  water: number;
  setWater: (water: number) => void;
  reflection: string;
  setReflection: (value: string) => void;
  completion: number;
  onCompleteDay: () => void;
  onDaySelect: (day: number) => void;
  onRecipeOpen: () => void;
  reminders: boolean;
  onReminderToggle: () => void;
  reminderMessage: string;
}) {
  const nextRecipe = recipes[activeDay % 10];
  const finishedTasks = tasks.filter((task) => completedTasks.includes(task.id)).length;

  return (
    <div className="page-flow">
      <section className="today-hero">
        <div className="hero-copy">
          <div className="hero-kicker"><span className="pulse-dot" /> Your focus for today</div>
          <p className="overline">DAY {String(activeDay).padStart(2, "0")}</p>
          <h2>{recipe.name}</h2>
          <p className="hero-description">{recipe.coachNote}</p>
          <div className="hero-meta">
            <span>◌ {recipe.note.replace("Source note: ", "")}</span>
            <span>◒ One recipe makes the day’s batch</span>
          </div>
        </div>
        <div className="progress-orbit" style={{ "--progress": `${completion * 3.6}deg` } as React.CSSProperties}>
          <div className="orbit-center"><strong>{completion}%</strong><span>complete</span></div>
        </div>
        <div className="hero-botanical" aria-hidden="true"><i /><i /><i /></div>
      </section>

      <section className="mode-switch-row" aria-label="Choose daily routine shape">
        <div>
          <p className="eyebrow">Your routine shape</p>
          <p className="small-copy">Choose the source pattern you intend to follow today.</p>
        </div>
        <div className="segmented-control">
          <button className={planMode === "full" ? "selected" : ""} onClick={() => setPlanMode("full")}>3 smoothies</button>
          <button className={planMode === "modified" ? "selected" : ""} onClick={() => setPlanMode("modified")}>2 + dinner</button>
        </div>
      </section>

      <div className="today-grid">
        <section className="ritual-card">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Today’s flow</p>
              <h3>Move through your day</h3>
            </div>
            <span className="count-pill">{finishedTasks}/{tasks.length} rituals</span>
          </div>
          <div className="task-list">
            {tasks.map((task, index) => {
              const complete = completedTasks.includes(task.id);
              return (
                <button key={task.id} className={`task-row ${complete ? "complete" : ""}`} onClick={() => onToggleTask(task.id)}>
                  <span className="task-check" aria-hidden="true">{complete ? "✓" : String(index + 1).padStart(2, "0")}</span>
                  <span className="task-content">
                    <small>{task.eyebrow}</small>
                    <strong>{task.title}</strong>
                    <em>{task.detail}</em>
                  </span>
                  <span className="task-arrow" aria-hidden="true">›</span>
                </button>
              );
            })}
          </div>
          <div className="tip-strip"><span>✦</span><p>Source reminder: drink a serving about every 3–4 hours, or sip the smoothie when hungry.</p></div>
        </section>

        <aside className="today-side">
          <section className="water-card">
            <div className="section-heading compact"><div><p className="eyebrow">Hydration</p><h3>Eight glasses</h3></div><span className="water-count">{water}/8</span></div>
            <p className="small-copy">The source target is at least 64 oz of water each day.</p>
            <div className="water-drops" aria-label={`${water} of 8 glasses marked`}>
              {Array.from({ length: 8 }, (_, index) => (
                <button key={index} className={index < water ? "filled" : ""} onClick={() => setWater(index < water ? index : index + 1)} aria-label={`Mark ${index + 1} glasses of water`}>
                  <span>◒</span>
                </button>
              ))}
            </div>
            <div className="water-actions"><button onClick={() => setWater(water - 1)} disabled={water === 0}>−</button><button onClick={() => setWater(water + 1)} disabled={water === 8}>Add a glass</button></div>
          </section>

          <section className="quick-recipe-card">
            <div className="recipe-flower" aria-hidden="true">✦</div>
            <p className="eyebrow">Today’s recipe</p>
            <h3>{recipe.name}</h3>
            <p>{recipe.ingredients.slice(0, 3).join(" · ")}</p>
            <button className="text-link" onClick={onRecipeOpen}>See all ingredients <span>→</span></button>
          </section>
        </aside>
      </div>

      <div className="lower-grid">
        <section className="checkin-card">
          <div className="section-heading"><div><p className="eyebrow">Your check-in</p><h3>How did the day feel?</h3></div><span className="reflection-mark">⌁</span></div>
          <textarea value={reflection} onChange={(event) => setReflection(event.target.value)} placeholder="A small note about your energy, routine, or what you want to prepare differently tomorrow…" aria-label="Daily reflection" />
          <div className="checkin-foot"><span>Saved privately in this browser.</span><button className="soft-button" onClick={onCompleteDay}>Mark day complete</button></div>
        </section>

        <section className="snack-card">
          <div className="section-heading compact"><div><p className="eyebrow">When hunger arrives</p><h3>Keep it simple</h3></div><span className="snack-icon">⌂</span></div>
          <div className="snack-list">{snacks.slice(0, 4).map((snack) => <span key={snack}>{snack}</span>)}</div>
          <p>Source-aligned snack ideas. The source also lists raw or unsalted nuts and seeds.</p>
        </section>
      </div>

      <section className="next-step-card">
        <div className="next-step-badge">NEXT</div>
        <div><p className="eyebrow">Make tomorrow lighter</p><h3>Day {nextRecipe.day}: {nextRecipe.name}</h3><p>Look ahead, then set aside the greens and fruit you’ll need.</p></div>
        <button onClick={() => onDaySelect(nextRecipe.day)}>Preview day {nextRecipe.day} <span>→</span></button>
      </section>

      <section className="reminder-row">
        <div><p className="eyebrow">Daily Coach Reminders</p><h3>Bring the next ritual into view</h3><p>Get a prep nudge at 9:00 and a check-in nudge at 19:00 while Smooth Coach is open in your browser.</p></div>
        <div className="reminder-control"><button className={`toggle ${reminders ? "on" : ""}`} onClick={onReminderToggle} aria-pressed={reminders}><span /></button><strong>{reminders ? "Nudges on" : "Nudges off"}</strong></div>
        {reminderMessage && <p className="reminder-message">{reminderMessage}</p>}
      </section>

      <SafetyNote />
    </div>
  );
}

function ProgramView({ activeDay, state, onDaySelect }: { activeDay: number; state: CoachState; onDaySelect: (day: number, destination?: View) => void }) {
  return (
    <div className="page-flow program-view">
      <section className="program-intro">
        <p className="eyebrow">The full rhythm</p>
        <h2>Ten recipes, one day at a time.</h2>
        <p>Each day uses one source recipe. Choose any day to make it your active guide, then return to Today for the coaching flow.</p>
      </section>
      <section className="timeline" aria-label="10-day cleanse program">
        {recipes.map((recipe, index) => {
          const progress = completionFor(state, recipe.day);
          const isActive = recipe.day === activeDay;
          return (
            <article className={`timeline-item ${isActive ? "active" : ""} ${progress === 100 ? "finished" : ""}`} key={recipe.day}>
              <div className="timeline-track"><span>{progress === 100 ? "✓" : String(recipe.day).padStart(2, "0")}</span>{index < recipes.length - 1 && <i />}</div>
              <button className="timeline-card" onClick={() => onDaySelect(recipe.day)}>
                <div><p>DAY {String(recipe.day).padStart(2, "0")} <span>{recipe.note.replace("Source note: ", "")}</span></p><h3>{recipe.name}</h3><small>{recipe.ingredients.slice(0, 3).join(" · ")}</small></div>
                <div className="timeline-card-side"><strong>{progress}%</strong><span>Open day <b>→</b></span></div>
              </button>
            </article>
          );
        })}
      </section>
    </div>
  );
}

function RecipesView({ activeDay, search, setSearch, recipes: visibleRecipes, onDaySelect }: { activeDay: number; search: string; setSearch: (value: string) => void; recipes: typeof recipes; onDaySelect: (day: number, destination?: View) => void }) {
  return (
    <div className="page-flow recipes-view">
      <section className="library-heading">
        <div><p className="eyebrow">Recipe library</p><h2>Everything for the blend.</h2><p>Every ingredient and quantity below is drawn from the supplied source document.</p></div>
        <label className="search-box"><span>⌕</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Find an ingredient or recipe" /></label>
      </section>
      <div className="recipe-library">
        {visibleRecipes.map((recipe) => (
          <article className={`recipe-card ${recipe.day === activeDay ? "current" : ""}`} key={recipe.day}>
            <div className="recipe-card-top"><span>DAY {String(recipe.day).padStart(2, "0")}</span><small>{recipe.note.replace("Source note: ", "")}</small></div>
            <h3>{recipe.name}</h3>
            <ul>{recipe.ingredients.map((ingredient) => <li key={ingredient}>{ingredient}</li>)}</ul>
            <div className="recipe-card-bottom"><span>Greens + water first, then remaining ingredients.</span><button onClick={() => onDaySelect(recipe.day)}>Make today <b>→</b></button></div>
          </article>
        ))}
      </div>
      {visibleRecipes.length === 0 && <p className="empty-state">No recipe matches that search. Try a fruit, green, or recipe name.</p>}
      <section className="directions-card"><div><p className="eyebrow">Everyday blend method</p><h3>Four gentle steps</h3></div><ol>{standardDirections.map((direction) => <li key={direction}>{direction}</li>)}</ol></section>
    </div>
  );
}

function PrepView({ onRecipeClick }: { onRecipeClick: (day: number) => void }) {
  return (
    <div className="page-flow prep-view">
      <section className="program-intro"><p className="eyebrow">Set yourself up</p><h2>Prep with less friction.</h2><p>Use the phase lists as a simple packing guide. Open the recipe library for exact amounts before shopping.</p></section>
      <div className="prep-phases">
        {phasePrep.map((phase, index) => (
          <article className="phase-card" key={phase.label}><span className="phase-number">0{index + 1}</span><p className="eyebrow">{phase.label}</p><h3>{phase.days}</h3><ul>{phase.items.map((item) => <li key={item}>{item}</li>)}</ul><button onClick={() => onRecipeClick(index === 0 ? 1 : 6)}>Open phase recipes <span>→</span></button></article>
        ))}
      </div>
      <div className="prep-guidance-grid">
        <section className="guide-card"><p className="eyebrow">Morning prep</p><h3>One recipe for the day</h3><p>The source says each recipe makes approximately a full day’s smoothie. It describes unblended ingredients as roughly 72 oz, blending down to about 36–48 oz depending on water and blender size.</p><p>Divide into thirds or sip from the refrigerated batch as needed.</p></section>
        <section className="guide-card contrast"><p className="eyebrow">Source food guide</p><h3>What to keep out of the cart</h3><div className="avoid-list">{avoidList.map((item) => <span key={item}>{item}</span>)}</div></section>
      </div>
      <SafetyNote />
    </div>
  );
}

function ProgressView({ state, completedDays, nextDay, onDaySelect }: { state: CoachState; completedDays: number; nextDay: number; onDaySelect: (day: number, destination?: View) => void }) {
  const activeReflection = dayEntry(state, state.activeDay).reflection;
  return (
    <div className="page-flow progress-view">
      <section className="progress-hero"><div><p className="eyebrow">Your progress</p><h2>{completedDays === 10 ? "Your 10-day guide is complete." : `${completedDays} of 10 days in view.`}</h2><p>Progress is stored on this device. A completed day means routine actions and the 8-glass tracker are all marked.</p></div><div className="big-progress"><strong>{Math.round((completedDays / 10) * 100)}%</strong><span>program complete</span></div></section>
      <section className="day-matrix">{recipes.map((recipe) => { const progress = completionFor(state, recipe.day); return <button className={`matrix-day ${progress === 100 ? "finished" : ""} ${state.activeDay === recipe.day ? "active" : ""}`} onClick={() => onDaySelect(recipe.day)} key={recipe.day}><span>{progress === 100 ? "✓" : String(recipe.day).padStart(2, "0")}</span><strong>{recipe.name}</strong><small>{progress}% complete</small></button>; })}</section>
      <section className="reflection-summary"><div><p className="eyebrow">Current reflection</p><h3>Day {state.activeDay}</h3><p>{activeReflection || "No note here yet. Go to Today whenever you want to capture a small observation."}</p></div><button onClick={() => onDaySelect(nextDay)}>Continue with day {nextDay} <span>→</span></button></section>
    </div>
  );
}

function SafetyNote() {
  return (
    <details className="safety-note">
      <summary><span>✦</span> A practical health note <b>+</b></summary>
      <div><p><strong>Smooth Coach organizes a user-supplied source—it is not medical advice or a medical “detox.”</strong> Speak with a qualified clinician before making a restrictive dietary change or adding supplements, especially if you are pregnant or breastfeeding, manage a medical condition, or take medication.</p><p>The supplied source mentions colon-cleansing methods and bowel-movement targets. This app does not turn those claims into a coaching step or recommendation.</p></div>
    </details>
  );
}

export default App;
