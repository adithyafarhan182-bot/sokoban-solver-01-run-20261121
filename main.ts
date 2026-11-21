// Sokoban solver: push-optimal per room.
//
// Every level is a one-wide hallway with 1-4 rooms off it, each room holding
// 3-4 boxes and as many goals, and a box pushed out of a room into the
// hallway can never come back. So each room is independent: solve every room
// on its own with a push-optimal A* search, then walk the player through the
// hallway from room to room and stitch the move strings together.
//
// Per room the search is A* over pushes. A state is the sorted box squares
// plus the player's square; a transition is one push, reached by walking the
// player to the square behind the box. The estimate is the cheapest
// assignment of boxes to goals under shortest-path distances (each push can
// lower that total by at most one, so it never overestimates). Dead states
// are cut early: squares a box can never be pushed away from towards a goal
// (found by pushing backwards from the goals), 2x2 blocks of boxes/walls
// with no goal inside, and boxes frozen solid by walls and other frozen
// boxes. Everything is budgeted by counted work, never by the clock, so two
// runs on the same set produce byte-identical output.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// Work budgets (counted expansions, never wall time, so runs stay identical).
const ROOM_EXPANSION_CAP = 400_000;
const TOTAL_EXPANSION_CAP = 3_000_000;

const DIRS: ReadonlyArray<readonly [number, number, string]> = [
  [0, -1, 'u'],
  [0, 1, 'd'],
  [-1, 0, 'l'],
  [1, 0, 'r'],
];

let expansionsUsed = 0;

interface Grid {
  w: number;
  h: number;
  wall: boolean[];
  goals: number[];
  goalSet: Set<number>;
  boxes: number[];
  player: number;
}

function parseLevel(text: string): Grid {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall: boolean[] = new Array(w * h).fill(true);
  const goals: number[] = [];
  const boxes: number[] = [];
  let player = 0;
  rows.forEach((row, y) => {
    for (let x = 0; x < w; x++) {
      const ch = row[x] ?? '#';
      const i = y * w + x;
      wall[i] = ch === '#';
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  boxes.sort((a, b) => a - b);
  return { w, h, wall, goals, goalSet: new Set(goals), boxes, player };
}

// Shortest walking distances from `from` over cells where `open(i)` holds.
// Returns a Map of cell -> distance (-1 = unreachable is simply absent).
function bfsDistances(
  from: number,
  w: number,
  h: number,
  open: (i: number) => boolean,
): Map<number, number> {
  const dist = new Map<number, number>();
  if (!open(from)) return dist;
  dist.set(from, 0);
  const queue: number[] = [from];
  let head = 0;
  while (head < queue.length) {
    const cur = queue[head++]!;
    const d = dist.get(cur)!;
    const cx = cur % w;
    const cy = (cur - cx) / w;
    for (const [dx, dy] of DIRS) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const ni = ny * w + nx;
      if (!open(ni) || dist.has(ni)) continue;
      dist.set(ni, d + 1);
      queue.push(ni);
    }
  }
  return dist;
}

// A walking path from `from` to `to` over cells where `open(i)` holds,
// as a string of u/d/l/r steps, or null when unreachable.
function walkPath(
  from: number,
  to: number,
  w: number,
  h: number,
  open: (i: number) => boolean,
): string | null {
  if (from === to) return '';
  const prev = new Map<number, { from: number; step: string }>();
  const queue: number[] = [from];
  prev.set(from, { from: -1, step: '' });
  let head = 0;
  while (head < queue.length) {
    const cur = queue[head++]!;
    const cx = cur % w;
    const cy = (cur - cx) / w;
    for (const [dx, dy, letter] of DIRS) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const ni = ny * w + nx;
      if (!open(ni) || prev.has(ni)) continue;
      prev.set(ni, { from: cur, step: letter });
      if (ni === to) {
        let moves = '';
        let at = ni;
        while (at !== from) {
          const step = prev.get(at)!;
          moves = step.step + moves;
          at = step.from;
        }
        return moves;
      }
      queue.push(ni);
    }
  }
  return null;
}

// ---- Per-room push-optimal search -------------------------------------------

interface RoomProblem {
  w: number;
  h: number;
  // Cells the player may walk on while solving this room (room cells plus the
  // single hallway cell in front of the door, so a box sitting on the door
  // square can still be pushed inward).
  walkable: Set<number>;
  // Cells a box may ever sit on (room cells only: a box in the hallway is lost).
  boxCells: Set<number>;
  goals: number[];
  boxes: number[];
  // Player square where the room search starts (the hallway cell at the door).
  entry: number;
}

// Squares from which a box can still be pushed onto some goal, found by
// pushing backwards: start at the goals and walk a box away from them, only
// where the player could have stood on the far side to make that push.
function liveSquares(prob: RoomProblem, wall: boolean[]): Set<number> {
  const { w, h, boxCells, goals, walkable } = prob;
  const live = new Set<number>(goals);
  const queue: number[] = [...goals];
  let head = 0;
  while (head < queue.length) {
    const y = queue[head++]!;
    const yx = y % w;
    const yy = (y - yx) / w;
    for (const [dx, dy] of DIRS) {
      // A push that moved a box from x into y along (dx, dy); the player
      // stood at x - (dx, dy) to make it.
      const x = y - dy * w - dx;
      const behind = x - dy * w - dx;
      if (x < 0 || x >= w * h) continue;
      const xx = x % w;
      const xy = (x - xx) / w;
      if (Math.abs(xx - yx) + Math.abs(xy - yy) !== 1) continue;
      if (!boxCells.has(x) || live.has(x)) continue;
      const bx = behind % w;
      const by = (behind - bx) / w;
      if (bx < 0 || by < 0 || bx >= w || by >= h) continue;
      if (wall[behind] || (!walkable.has(behind) && behind !== prob.entry)) continue;
      live.add(x);
      queue.push(x);
    }
  }
  return live;
}

// True when the box layout is plainly lost: a box on a square that is not a
// goal and not live, a 2x2 block of boxes/walls holding a box but no goal, or
// a box frozen solid (both neighbours blocked on both axes) off a goal.
function isDeadLayout(
  boxes: number[],
  boxSet: Set<number>,
  live: Set<number>,
  goals: Set<number>,
  wall: boolean[],
  w: number,
  h: number,
): boolean {
  for (const b of boxes) {
    if (!goals.has(b) && !live.has(b)) return true;
  }
  // 2x2 blocks.
  for (let y = 0; y + 1 < h; y++) {
    for (let x = 0; x + 1 < w; x++) {
      const cells = [y * w + x, y * w + x + 1, (y + 1) * w + x, (y + 1) * w + x + 1];
      let hasBox = false;
      let hasGoal = false;
      let allSolid = true;
      for (const c of cells) {
        if (goals.has(c)) hasGoal = true;
        if (boxSet.has(c)) hasBox = true;
        else if (!wall[c]) allSolid = false;
      }
      if (hasBox && allSolid && !hasGoal) return true;
    }
  }
  // Frozen boxes, grown to a fixed point: a box is frozen when it cannot be
  // pushed along either axis because every neighbour is a wall or frozen.
  const frozen = new Set<number>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const b of boxes) {
      if (frozen.has(b) || goals.has(b)) continue;
      const bx = b % w;
      const by = (b - bx) / w;
      const blocked = (nx: number, ny: number): boolean => {
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) return true;
        const c = ny * w + nx;
        return wall[c] || frozen.has(c);
      };
      const stuckX = blocked(bx - 1, by) && blocked(bx + 1, by);
      const stuckY = blocked(bx, by - 1) && blocked(bx, by + 1);
      if (stuckX && stuckY) {
        frozen.add(b);
        changed = true;
      }
    }
  }
  return frozen.size > 0;
}

// Encode up to 4 sorted box squares (< 256 cells) plus the player square
// into one exact number, for use as a Map key.
function encodeState(boxes: number[], player: number): number {
  let code = 0;
  let mul = 1;
  for (const b of boxes) {
    code += b * mul;
    mul *= 256;
  }
  return code * 256 + player;
}

function decodeBoxes(code: number, n: number): number[] {
  const boxes: number[] = [];
  let rest = Math.floor(code / 256);
  for (let i = 0; i < n; i++) {
    boxes.push(rest % 256);
    rest = Math.floor(rest / 256);
  }
  return boxes;
}

// Push-optimal A* for one room. Returns the move string (walks + pushes,
// lower-case letters for walks, the push step itself in lower case too —
// the checker decides which steps push) or null when the budget runs out.
function solveRoom(prob: RoomProblem, wall: boolean[]): string | null {
  const { w, h, walkable, boxCells, goals, boxes, entry } = prob;
  const n = boxes.length;
  if (n === 0) return '';
  if (n !== goals.length) return null;
  const goalSet = new Set(goals);
  const live = liveSquares(prob, wall);
  for (const b of boxes) {
    if (!goalSet.has(b) && !live.has(b)) return null;
  }
  if (isDeadLayout(boxes, new Set(boxes), live, goalSet, wall, w, h)) return null;

  // Shortest box-travel distances from each goal over box cells.
  const goalDist: Map<number, number>[] = goals.map((g) =>
    bfsDistances(g, w, h, (i) => boxCells.has(i)),
  );
  // Cheapest assignment of boxes to goals; Infinity when some box cannot
  // reach every goal it might need (a sound prune, never an overestimate).
  const heuristic = (bs: number[]): number => {
    let best = Infinity;
    const perm = goals.map((_, i) => i);
    const tryPerm = (k: number, acc: number): void => {
      if (acc >= best) return;
      if (k === n) {
        if (acc < best) best = acc;
        return;
      }
      for (let i = k; i < n; i++) {
        [perm[k], perm[i]] = [perm[i]!, perm[k]!];
        const d = goalDist[perm[k]!]!.get(bs[k]!);
        if (d !== undefined) tryPerm(k + 1, acc + d);
        [perm[k], perm[i]] = [perm[i]!, perm[k]!];
      }
    };
    tryPerm(0, 0);
    return best;
  };

  const startBoxes = [...boxes].sort((a, b) => a - b);
  const startCode = encodeState(startBoxes, entry);
  const codes: number[] = [startCode];
  const players: number[] = [entry];
  const gs: number[] = [0];
  const parents: number[] = [-1];
  const segs: string[] = [''];
  const fs: number[] = [heuristic(startBoxes)];
  const seqs: number[] = [0];
  let seqCounter = 1;
  const best = new Map<number, number>();
  best.set(startCode, 0);

  // Binary heap of state indices, ordered by (f, g descending, seq).
  const heap: number[] = [0];
  const lessIdx = (a: number, b: number): boolean => {
    if (fs[a] !== fs[b]) return fs[a]! < fs[b]!;
    if (gs[a] !== gs[b]) return gs[a]! > gs[b]!;
    return seqs[a]! < seqs[b]!;
  };
  const heapPush = (idx: number): void => {
    heap.push(idx);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!lessIdx(heap[i]!, heap[p]!)) break;
      [heap[i], heap[p]] = [heap[p]!, heap[i]!];
      i = p;
    }
  };
  const heapPop = (): number => {
    const top = heap[0]!;
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      for (let i = 0; ; ) {
        let c = 2 * i + 1;
        if (c >= heap.length) break;
        if (c + 1 < heap.length && lessIdx(heap[c + 1]!, heap[c]!)) c++;
        if (!lessIdx(heap[c]!, heap[i]!)) break;
        [heap[i], heap[c]] = [heap[c]!, heap[i]!];
        i = c;
      }
    }
    return top;
  };

  let roomExpansions = 0;
  while (heap.length > 0) {
    if (roomExpansions >= ROOM_EXPANSION_CAP || expansionsUsed >= TOTAL_EXPANSION_CAP) {
      return null;
    }
    const s = heapPop();
    if (best.get(codes[s]!) !== s) continue;
    const bs = decodeBoxes(codes[s]!, n);
    if (bs.every((b) => goalSet.has(b))) {
      let moves = '';
      for (let t = s; t > 0; t = parents[t]!) moves = segs[t]! + moves;
      return moves;
    }
    roomExpansions++;
    expansionsUsed++;
    const player = players[s]!;
    const boxSet = new Set(bs);
    const reach = bfsDistances(player, w, h, (i) => walkable.has(i) && !boxSet.has(i));
    for (let bi = 0; bi < n; bi++) {
      const b = bs[bi]!;
      const bx = b % w;
      const by = (b - bx) / w;
      for (const [dx, dy, letter] of DIRS) {
        const tx = bx + dx;
        const ty = by + dy;
        if (tx < 0 || ty < 0 || tx >= w || ty >= h) continue;
        const target = ty * w + tx;
        if (!boxCells.has(target) || boxSet.has(target)) continue;
        if (!goalSet.has(target) && !live.has(target)) continue;
        const behind = b - dy * w - dx;
        if (!reach.has(behind)) continue;
        const walk = walkPath(player, behind, w, h, (i) => walkable.has(i) && !boxSet.has(i));
        if (walk === null) continue;
        const nb = [...bs];
        nb[bi] = target;
        nb.sort((a, b2) => a - b2);
        const nbSet = new Set(nb);
        if (isDeadLayout(nb, nbSet, live, goalSet, wall, w, h)) continue;
        const hEst = heuristic(nb);
        if (hEst === Infinity) continue;
        const code = encodeState(nb, b);
        const g2 = gs[s]! + 1;
        const seen = best.get(code);
        if (seen !== undefined && gs[seen]! <= g2) continue;
        const t = codes.length;
        codes.push(code);
        players.push(b);
        gs.push(g2);
        parents.push(s);
        segs.push(walk + letter);
        fs.push(g2 + hEst);
        seqs.push(seqCounter++);
        best.set(code, t);
        heapPush(t);
      }
    }
  }
  return null;
}

// ---- Level assembly ----------------------------------------------------------

// Split a level into its rooms: connected floor components once the hallway
// row (the row the player starts on) is taken out. Each room's door is its
// cell next to the hallway; the player enters through the hallway cell
// beside that door.
function findRooms(grid: Grid): RoomProblem[] | null {
  const { w, h, wall, player } = grid;
  const hallRow = (player - (player % w)) / w;
  const seen = new Set<number>();
  const rooms: RoomProblem[] = [];
  for (let y = 0; y < h; y++) {
    if (y === hallRow) continue;
    for (let x = 0; x < w; x++) {
      const start = y * w + x;
      if (wall[start] || seen.has(start)) continue;
      const cells: number[] = [];
      const queue: number[] = [start];
      seen.add(start);
      let head = 0;
      while (head < queue.length) {
        const cur = queue[head++]!;
        cells.push(cur);
        const cx = cur % w;
        const cy = (cur - cx) / w;
        for (const [dx, dy] of DIRS) {
          const nx = cx + dx;
          const ny = cy + dy;
          if (ny === hallRow || nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const ni = ny * w + nx;
          if (wall[ni] || seen.has(ni)) continue;
          seen.add(ni);
          queue.push(ni);
        }
      }
      const cellSet = new Set(cells);
      const boxes = grid.boxes.filter((b) => cellSet.has(b));
      const goals = grid.goals.filter((g) => cellSet.has(g));
      if (boxes.length === 0 && goals.length === 0) continue;
      // The door: the room cell with a hallway neighbour.
      let door = -1;
      let entry = -1;
      for (const c of cells) {
        const cy = (c - (c % w)) / w;
        const ny = cy < hallRow ? cy + 1 : cy - 1;
        if (ny !== hallRow) continue;
        const n = ny * w + (c % w);
        if (!wall[n]) {
          door = c;
          entry = n;
          break;
        }
      }
      if (door < 0) return null;
      const walkable = new Set(cells);
      walkable.add(entry);
      rooms.push({ w, h, walkable, boxCells: cellSet, goals, boxes, entry });
    }
  }
  // Every box and goal must belong to exactly one room.
  const covered = rooms.reduce((a, r) => a + r.boxes.length, 0);
  if (covered !== grid.boxes.length) return null;
  const coveredGoals = rooms.reduce((a, r) => a + r.goals.length, 0);
  if (coveredGoals !== grid.goals.length) return null;
  // Visit rooms in a fixed order: top rooms left to right, then bottom ones.
  rooms.sort((a, b) => a.entry - b.entry);
  return rooms;
}

function solveLevel(text: string): string {
  const grid = parseLevel(text);
  const rooms = findRooms(grid);
  if (rooms !== null) {
    let moves = '';
    let player = grid.player;
    let boxes = new Set(grid.boxes);
    for (const room of rooms) {
      const openWalk = (i: number): boolean =>
        !grid.wall[i] && !boxes.has(i);
      const toEntry = walkPath(player, room.entry, grid.w, grid.h, openWalk);
      if (toEntry === null) return '';
      moves += toEntry;
      const roomMoves = solveRoom(room, grid.wall);
      if (roomMoves === null) return '';
      moves += roomMoves;
      // Replay everything so far: the player ends inside the room and the
      // room's boxes now sit on their goals. Walk back out to the hallway,
      // treating the boxes exactly where they now are as obstacles.
      const state = replay(grid.player, moves, grid);
      const out = walkPath(state.player, room.entry, grid.w, grid.h, (i) => {
        return !grid.wall[i] && !state.boxes.has(i);
      });
      if (out === null) return '';
      moves += out;
      player = room.entry;
      boxes = state.boxes;
    }
    return moves;
  }
  // Fallback: no clean room split — run the same push search on the whole
  // level, with the player starting where the level puts them.
  const whole: RoomProblem = {
    w: grid.w,
    h: grid.h,
    walkable: new Set(
      grid.wall.map((isWall, i) => (isWall ? -1 : i)).filter((i) => i >= 0),
    ),
    boxCells: new Set(
      grid.wall.map((isWall, i) => (isWall ? -1 : i)).filter((i) => i >= 0),
    ),
    goals: grid.goals,
    boxes: grid.boxes,
    entry: grid.player,
  };
  return solveRoom(whole, grid.wall) ?? '';
}

// Replay a move string on the level and return the player's final square
// and the boxes' final squares (used to know where everything stands after
// a room is solved, so the walk back out sees the boxes where they are).
function replay(
  start: number,
  moves: string,
  grid: Grid,
): { player: number; boxes: Set<number> } {
  const boxes = new Set(grid.boxes);
  let p = start;
  for (const ch of moves) {
    const lower = ch.toLowerCase();
    const dir = DIRS.find((d) => d[2] === lower);
    if (!dir) continue;
    const q = p + dir[1] * grid.w + dir[0];
    if (grid.wall[q]) continue;
    if (boxes.has(q)) {
      const t = q + dir[1] * grid.w + dir[0];
      if (grid.wall[t] || boxes.has(t)) continue;
      boxes.delete(q);
      boxes.add(t);
    }
    p = q;
  }
  return { player: p, boxes };
}

for (const id of readdirSync(INPUT_DIR).sort()) {
  const moves = solveLevel(readFileSync(join(INPUT_DIR, id, 'level.txt'), 'utf8'));
  mkdirSync(join(OUTPUT_DIR, id), { recursive: true });
  writeFileSync(join(OUTPUT_DIR, id, 'solution.txt'), `${moves}\n`);
}
