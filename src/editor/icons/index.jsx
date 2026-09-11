import { forwardRef } from "react";
import {
  Leaf as PhLeaf,
  Aperture as PhAperture,
  Archive as PhArchive,
  ArrowCounterClockwise as PhArrowCounterClockwise,
  ArrowDown as PhArrowDown,
  ArrowElbowDownLeft as PhArrowElbowDownLeft,
  ArrowLineDown as PhArrowLineDown,
  ArrowRight as PhArrowRight,
  ArrowSquareOut as PhArrowSquareOut,
  ArrowUUpLeft as PhArrowUUpLeft,
  ArrowUUpRight as PhArrowUUpRight,
  ArrowUp as PhArrowUp,
  ArrowsClockwise as PhArrowsClockwise,
  ArrowsIn as PhArrowsIn,
  ArrowsOut as PhArrowsOut,
  ArrowsOutCardinal as PhArrowsOutCardinal,
  BezierCurve as PhBezierCurve,
  Bone as PhBone,
  Books as PhBooks,
  BoundingBox as PhBoundingBox,
  BracketsCurly as PhBracketsCurly,
  Brain as PhBrain,
  Broadcast as PhBroadcast,
  Buildings as PhBuildings,
  Camera as PhCamera,
  CaretDown as PhCaretDown,
  CaretRight as PhCaretRight,
  CaretUp as PhCaretUp,
  Check as PhCheck,
  CheckCircle as PhCheckCircle,
  CheckSquare as PhCheckSquare,
  Circle as PhCircle,
  CircleDashed as PhCircleDashed,
  CircleHalf as PhCircleHalf,
  CircleNotch as PhCircleNotch,
  Clipboard as PhClipboard,
  ClipboardText as PhClipboardText,
  Clock as PhClock,
  ClockCounterClockwise as PhClockCounterClockwise,
  Cloud as PhCloud,
  CloudArrowUp as PhCloudArrowUp,
  CloudCheck as PhCloudCheck,
  CloudSun as PhCloudSun,
  Code as PhCode,
  Command as PhCommand,
  Copy as PhCopy,
  CopySimple as PhCopySimple,
  Cpu as PhCpu,
  Crop as PhCrop,
  Crosshair as PhCrosshair,
  Cube as PhCube,
  Cursor as PhCursor,
  CursorClick as PhCursorClick,
  Cylinder as PhCylinder,
  DeviceMobile as PhDeviceMobile,
  Diamond as PhDiamond,
  Door as PhDoor,
  DownloadSimple as PhDownloadSimple,
  Drop as PhDrop,
  Eraser as PhEraser,
  Eye as PhEye,
  EyeSlash as PhEyeSlash,
  Eyedropper as PhEyedropper,
  Feather as PhFeather,
  File as PhFile,
  FileArchive as PhFileArchive,
  FileCode as PhFileCode,
  FileDashed as PhFileDashed,
  FileMagnifyingGlass as PhFileMagnifyingGlass,
  FilePlus as PhFilePlus,
  FileX as PhFileX,
  Files as PhFiles,
  FilmSlate as PhFilmSlate,
  FilmStrip as PhFilmStrip,
  FlipHorizontal as PhFlipHorizontal,
  FloppyDisk as PhFloppyDisk,
  FlowArrow as PhFlowArrow,
  Folder as PhFolder,
  FolderOpen as PhFolderOpen,
  FolderPlus as PhFolderPlus,
  Footprints as PhFootprints,
  FrameCorners as PhFrameCorners,
  GameController as PhGameController,
  Gear as PhGear,
  GearSix as PhGearSix,
  GitBranch as PhGitBranch,
  GitCommit as PhGitCommit,
  GitFork as PhGitFork,
  GitMerge as PhGitMerge,
  Globe as PhGlobe,
  GridFour as PhGridFour,
  GridNine as PhGridNine,
  Hammer as PhHammer,
  Hash as PhHash,
  Image as PhImage,
  Images as PhImages,
  Info as PhInfo,
  Intersect as PhIntersect,
  Key as PhKey,
  Keyboard as PhKeyboard,
  Lasso as PhLasso,
  Layout as PhLayout,
  Lightbulb as PhLightbulb,
  Lightning as PhLightning,
  Link as PhLink,
  LinkBreak as PhLinkBreak,
  LinkSimple as PhLinkSimple,
  LinkSimpleBreak as PhLinkSimpleBreak,
  List as PhList,
  ListChecks as PhListChecks,
  Lock as PhLock,
  LockOpen as PhLockOpen,
  MagicWand as PhMagicWand,
  Magnet as PhMagnet,
  MagnifyingGlass as PhMagnifyingGlass,
  MagnifyingGlassMinus as PhMagnifyingGlassMinus,
  MagnifyingGlassPlus as PhMagnifyingGlassPlus,
  MapTrifold as PhMapTrifold,
  Minus as PhMinus,
  MinusSquare as PhMinusSquare,
  Monitor as PhMonitor,
  Mountains as PhMountains,
  Mouse as PhMouse,
  MusicNote as PhMusicNote,
  Note as PhNote,
  Package as PhPackage,
  PaintBrush as PhPaintBrush,
  PaintBucket as PhPaintBucket,
  Palette as PhPalette,
  Paperclip as PhPaperclip,
  Path as PhPath,
  Pause as PhPause,
  Pencil as PhPencil,
  PencilRuler as PhPencilRuler,
  PencilSlash as PhPencilSlash,
  Person as PhPerson,
  Pizza as PhPizza,
  Planet as PhPlanet,
  Play as PhPlay,
  Plug as PhPlug,
  Plus as PhPlus,
  PlusSquare as PhPlusSquare,
  Power as PhPower,
  Prohibit as PhProhibit,
  Pulse as PhPulse,
  PushPin as PhPushPin,
  PuzzlePiece as PhPuzzlePiece,
  QrCode as PhQrCode,
  RadioButton as PhRadioButton,
  Rectangle as PhRectangle,
  Repeat as PhRepeat,
  Resize as PhResize,
  Robot as PhRobot,
  Rows as PhRows,
  Scan as PhScan,
  Scissors as PhScissors,
  Scroll as PhScroll,
  SelectionPlus as PhSelectionPlus,
  Shapes as PhShapes,
  ShareNetwork as PhShareNetwork,
  ShieldCheck as PhShieldCheck,
  ShieldPlus as PhShieldPlus,
  ShieldWarning as PhShieldWarning,
  Shuffle as PhShuffle,
  SidebarSimple as PhSidebarSimple,
  SignIn as PhSignIn,
  Signpost as PhSignpost,
  SkipForward as PhSkipForward,
  Sliders as PhSliders,
  SlidersHorizontal as PhSlidersHorizontal,
  Sparkle as PhSparkle,
  SpeakerHigh as PhSpeakerHigh,
  SpeakerSlash as PhSpeakerSlash,
  Square as PhSquare,
  SquareLogo as PhSquareLogo,
  SquaresFour as PhSquaresFour,
  Stack as PhStack,
  StackSimple as PhStackSimple,
  Stamp as PhStamp,
  Storefront as PhStorefront,
  Sun as PhSun,
  Sword as PhSword,
  Tag as PhTag,
  Target as PhTarget,
  Terminal as PhTerminal,
  TerminalWindow as PhTerminalWindow,
  TextAlignCenter as PhTextAlignCenter,
  TextAlignLeft as PhTextAlignLeft,
  TextAlignRight as PhTextAlignRight,
  TextT as PhTextT,
  Textbox as PhTextbox,
  Trash as PhTrash,
  TreeStructure as PhTreeStructure,
  Triangle as PhTriangle,
  VideoCamera as PhVideoCamera,
  Warning as PhWarning,
  WarningCircle as PhWarningCircle,
  Waveform as PhWaveform,
  Waves as PhWaves,
  WifiHigh as PhWifiHigh,
  Wind as PhWind,
  X as PhX,
  XSquare as PhXSquare,
} from "@phosphor-icons/react";

export { ClaudeIcon, CodexIcon } from "./BrandIcons.jsx";

/**
 * Every icon in the editor, in one place.
 *
 * WHY THIS MODULE EXISTS: the editor used to import from `lucide-react` in
 * 82 files, so its icon set was 82 decisions rather than one. Now each file
 * imports from here, and the set is a single edit — which is what made
 * moving OFF lucide (user, 2026-09-08: "i want filled icons, not hollow";
 * lucide "is everywhere already") a one-file change rather than a sweep.
 *
 * The names are the ones the editor already called them by, so a call site
 * reads the same as before; only the drawing behind it changed. That also
 * means a name here is the editor's word for a concept, not a promise about
 * which library draws it — `Search` is Phosphor's MagnifyingGlass, `Save`
 * its FloppyDisk, `Zap` its Lightning.
 *
 * WEIGHT: `fill` throughout. See `BOLD` in the generator (and the short
 * list below) for the handful whose meaning lives in a gap.
 *
 * Two lucide props are swallowed rather than forwarded: `strokeWidth` and
 * `absoluteStrokeWidth` mean nothing to a filled icon, and React would
 * otherwise pass `absoluteStrokeWidth` to the DOM and warn about it. Every
 * other prop (size, color, className, weight, onClick, aria-*) goes through,
 * so a call site can still ask for a different weight one-off.
 *
 * Generated — to change a mapping, edit it here directly; there is no
 * build step that rewrites this file.
 */

/** lucide's default. Nearly every call site passes its own size. */
const DEFAULT_SIZE = 24;
const DEFAULT_WEIGHT = "fill";

function icon(Component, name, weight = DEFAULT_WEIGHT) {
  const Icon = forwardRef(function Icon(
    { size = DEFAULT_SIZE, strokeWidth, absoluteStrokeWidth, ...rest },
    ref,
  ) {
    return <Component ref={ref} size={size} weight={weight} {...rest} />;
  });
  Icon.displayName = name;
  return Icon;
}

export const Activity = /* @__PURE__ */ icon(PhPulse, "Activity");
export const AlertCircle = /* @__PURE__ */ icon(PhWarningCircle, "AlertCircle");
export const AlertTriangle = /* @__PURE__ */ icon(PhWarning, "AlertTriangle");
export const AlignCenter = /* @__PURE__ */ icon(PhTextAlignCenter, "AlignCenter");
export const AlignLeft = /* @__PURE__ */ icon(PhTextAlignLeft, "AlignLeft");
export const AlignRight = /* @__PURE__ */ icon(PhTextAlignRight, "AlignRight");
export const Aperture = /* @__PURE__ */ icon(PhAperture, "Aperture");
export const Archive = /* @__PURE__ */ icon(PhArchive, "Archive");
export const ArrowDown = /* @__PURE__ */ icon(PhArrowDown, "ArrowDown");
export const ArrowRight = /* @__PURE__ */ icon(PhArrowRight, "ArrowRight");
export const ArrowUp = /* @__PURE__ */ icon(PhArrowUp, "ArrowUp");
export const AudioLines = /* @__PURE__ */ icon(PhWaveform, "AudioLines");
export const AudioWaveform = /* @__PURE__ */ icon(PhWaveform, "AudioWaveform");
export const Axis3d = /* @__PURE__ */ icon(PhArrowsOutCardinal, "Axis3d");
export const Blend = /* @__PURE__ */ icon(PhIntersect, "Blend");
export const Blocks = /* @__PURE__ */ icon(PhSquaresFour, "Blocks");
export const Bone = /* @__PURE__ */ icon(PhBone, "Bone");
export const Bot = /* @__PURE__ */ icon(PhRobot, "Bot");
export const Box = /* @__PURE__ */ icon(PhCube, "Box");
export const Boxes = /* @__PURE__ */ icon(PhCube, "Boxes");
export const Braces = /* @__PURE__ */ icon(PhBracketsCurly, "Braces");
export const BrainCircuit = /* @__PURE__ */ icon(PhBrain, "BrainCircuit");
export const Brush = /* @__PURE__ */ icon(PhPaintBrush, "Brush");
export const Building2 = /* @__PURE__ */ icon(PhBuildings, "Building2");
export const Camera = /* @__PURE__ */ icon(PhCamera, "Camera");
// A tick is a STROKE, and Phosphor's `fill` weight does not fill a stroke —
// it swaps in a filled tile with the mark knocked out, so the default weight
// turned every "copied ✓" and every selected-row marker into what reads as a
// checkbox. Bold draws the checkmark itself. (Same reason ChevronDown below
// opts out of `fill`.)
export const Check = /* @__PURE__ */ icon(PhCheck, "Check", "bold");
export const CheckCircle2 = /* @__PURE__ */ icon(PhCheckCircle, "CheckCircle2");
export const CheckSquare = /* @__PURE__ */ icon(PhCheckSquare, "CheckSquare");
// A disclosure control is an ARROW, not a solid triangle: filled, Phosphor
// caret becomes a wedge that reads as a marker rather than something you
// click to fold. Bold draws the same icon as the thin chevron it replaced.
export const ChevronDown = /* @__PURE__ */ icon(PhCaretDown, "ChevronDown", "bold");
export const ChevronRight = /* @__PURE__ */ icon(PhCaretRight, "ChevronRight", "bold");
export const ChevronUp = /* @__PURE__ */ icon(PhCaretUp, "ChevronUp", "bold");
export const Circle = /* @__PURE__ */ icon(PhCircle, "Circle");
export const CircleDashed = /* @__PURE__ */ icon(PhCircleDashed, "CircleDashed", "bold");
export const CircleDot = /* @__PURE__ */ icon(PhRadioButton, "CircleDot", "bold");
export const CircleSlash2 = /* @__PURE__ */ icon(PhProhibit, "CircleSlash2");
export const Clapperboard = /* @__PURE__ */ icon(PhFilmSlate, "Clapperboard");
export const Clipboard = /* @__PURE__ */ icon(PhClipboard, "Clipboard");
export const ClipboardPaste = /* @__PURE__ */ icon(PhClipboardText, "ClipboardPaste");
export const Clock = /* @__PURE__ */ icon(PhClock, "Clock");
export const Cloud = /* @__PURE__ */ icon(PhCloud, "Cloud");
export const CloudCheck = /* @__PURE__ */ icon(PhCloudCheck, "CloudCheck");
export const CloudSun = /* @__PURE__ */ icon(PhCloudSun, "CloudSun");
export const CloudUpload = /* @__PURE__ */ icon(PhCloudArrowUp, "CloudUpload");
export const Code = /* @__PURE__ */ icon(PhCode, "Code");
export const Command = /* @__PURE__ */ icon(PhCommand, "Command");
export const Contrast = /* @__PURE__ */ icon(PhCircleHalf, "Contrast");
export const Copy = /* @__PURE__ */ icon(PhCopy, "Copy");
export const CopyPlus = /* @__PURE__ */ icon(PhCopySimple, "CopyPlus");
export const CornerDownLeft = /* @__PURE__ */ icon(PhArrowElbowDownLeft, "CornerDownLeft");
export const Cpu = /* @__PURE__ */ icon(PhCpu, "Cpu");
export const Crop = /* @__PURE__ */ icon(PhCrop, "Crop");
export const Crosshair = /* @__PURE__ */ icon(PhCrosshair, "Crosshair");
export const Cylinder = /* @__PURE__ */ icon(PhCylinder, "Cylinder");
export const Diamond = /* @__PURE__ */ icon(PhDiamond, "Diamond");
export const DoorOpen = /* @__PURE__ */ icon(PhDoor, "DoorOpen");
export const Download = /* @__PURE__ */ icon(PhDownloadSimple, "Download");
export const Droplet = /* @__PURE__ */ icon(PhDrop, "Droplet");
export const Eraser = /* @__PURE__ */ icon(PhEraser, "Eraser");
export const ExternalLink = /* @__PURE__ */ icon(PhArrowSquareOut, "ExternalLink");
export const Eye = /* @__PURE__ */ icon(PhEye, "Eye");
export const EyeOff = /* @__PURE__ */ icon(PhEyeSlash, "EyeOff");
export const Feather = /* @__PURE__ */ icon(PhFeather, "Feather");
export const File = /* @__PURE__ */ icon(PhFile, "File");
export const FileBox = /* @__PURE__ */ icon(PhFileArchive, "FileBox");
export const FileCode = /* @__PURE__ */ icon(PhFileCode, "FileCode");
export const FileCode2 = /* @__PURE__ */ icon(PhFileCode, "FileCode2");
export const FileDiff = /* @__PURE__ */ icon(PhFileDashed, "FileDiff", "bold");
export const FilePlus = /* @__PURE__ */ icon(PhFilePlus, "FilePlus");
export const FilePlus2 = /* @__PURE__ */ icon(PhFilePlus, "FilePlus2");
export const FileSearch = /* @__PURE__ */ icon(PhFileMagnifyingGlass, "FileSearch");
export const FileX2 = /* @__PURE__ */ icon(PhFileX, "FileX2");
export const Files = /* @__PURE__ */ icon(PhFiles, "Files");
export const Film = /* @__PURE__ */ icon(PhFilmStrip, "Film");
export const FlipHorizontal = /* @__PURE__ */ icon(PhFlipHorizontal, "FlipHorizontal");
export const Folder = /* @__PURE__ */ icon(PhFolder, "Folder");
export const FolderOpen = /* @__PURE__ */ icon(PhFolderOpen, "FolderOpen");
export const FolderPlus = /* @__PURE__ */ icon(PhFolderPlus, "FolderPlus");
export const Footprints = /* @__PURE__ */ icon(PhFootprints, "Footprints");
export const Frame = /* @__PURE__ */ icon(PhFrameCorners, "Frame", "bold");
export const Gamepad2 = /* @__PURE__ */ icon(PhGameController, "Gamepad2");
export const GitBranch = /* @__PURE__ */ icon(PhGitBranch, "GitBranch");
export const GitCommitHorizontal = /* @__PURE__ */ icon(PhGitCommit, "GitCommitHorizontal");
export const GitFork = /* @__PURE__ */ icon(PhGitFork, "GitFork");
export const GitMerge = /* @__PURE__ */ icon(PhGitMerge, "GitMerge");
export const Globe = /* @__PURE__ */ icon(PhGlobe, "Globe");
export const Grid2x2 = /* @__PURE__ */ icon(PhGridFour, "Grid2x2");
export const Grid3x3 = /* @__PURE__ */ icon(PhGridNine, "Grid3x3");
export const Hammer = /* @__PURE__ */ icon(PhHammer, "Hammer");
export const Hash = /* @__PURE__ */ icon(PhHash, "Hash");
export const History = /* @__PURE__ */ icon(PhClockCounterClockwise, "History");
export const Image = /* @__PURE__ */ icon(PhImage, "Image");
export const Images = /* @__PURE__ */ icon(PhImages, "Images");
export const Import = /* @__PURE__ */ icon(PhArrowLineDown, "Import");
export const Info = /* @__PURE__ */ icon(PhInfo, "Info");
export const KeyRound = /* @__PURE__ */ icon(PhKey, "KeyRound");
export const Keyboard = /* @__PURE__ */ icon(PhKeyboard, "Keyboard");
export const Lasso = /* @__PURE__ */ icon(PhLasso, "Lasso");
export const Layers = /* @__PURE__ */ icon(PhStack, "Layers");
export const Layers2 = /* @__PURE__ */ icon(PhStackSimple, "Layers2");
export const Layers3 = /* @__PURE__ */ icon(PhStack, "Layers3");
export const LayoutGrid = /* @__PURE__ */ icon(PhSquaresFour, "LayoutGrid");
export const LayoutTemplate = /* @__PURE__ */ icon(PhLayout, "LayoutTemplate");
export const Library = /* @__PURE__ */ icon(PhBooks, "Library");
export const Lightbulb = /* @__PURE__ */ icon(PhLightbulb, "Lightbulb");
export const Link = /* @__PURE__ */ icon(PhLink, "Link");
export const Link2 = /* @__PURE__ */ icon(PhLinkSimple, "Link2");
export const Link2Off = /* @__PURE__ */ icon(PhLinkSimpleBreak, "Link2Off");
export const List = /* @__PURE__ */ icon(PhList, "List");
export const ListChecks = /* @__PURE__ */ icon(PhListChecks, "ListChecks");
export const ListTree = /* @__PURE__ */ icon(PhTreeStructure, "ListTree");
export const Leaf = /* @__PURE__ */ icon(PhLeaf, "Leaf");
export const Loader2 = /* @__PURE__ */ icon(PhCircleNotch, "Loader2", "bold");
export const Lock = /* @__PURE__ */ icon(PhLock, "Lock");
export const LockOpen = /* @__PURE__ */ icon(PhLockOpen, "LockOpen");
export const LogIn = /* @__PURE__ */ icon(PhSignIn, "LogIn");
export const Magnet = /* @__PURE__ */ icon(PhMagnet, "Magnet");
export const Map = /* @__PURE__ */ icon(PhMapTrifold, "Map");
export const Maximize2 = /* @__PURE__ */ icon(PhArrowsOut, "Maximize2");
export const Milestone = /* @__PURE__ */ icon(PhSignpost, "Milestone");
export const Minimize2 = /* @__PURE__ */ icon(PhArrowsIn, "Minimize2");
export const Minus = /* @__PURE__ */ icon(PhMinus, "Minus");
export const Monitor = /* @__PURE__ */ icon(PhMonitor, "Monitor");
export const Mountain = /* @__PURE__ */ icon(PhMountains, "Mountain");
export const Mouse = /* @__PURE__ */ icon(PhMouse, "Mouse");
export const MousePointer2 = /* @__PURE__ */ icon(PhCursor, "MousePointer2");
export const MousePointerClick = /* @__PURE__ */ icon(PhCursorClick, "MousePointerClick");
export const Move = /* @__PURE__ */ icon(PhArrowsOutCardinal, "Move");
export const Move3d = /* @__PURE__ */ icon(PhArrowsOutCardinal, "Move3d");
export const Music = /* @__PURE__ */ icon(PhMusicNote, "Music");
export const Orbit = /* @__PURE__ */ icon(PhPlanet, "Orbit");
export const Package = /* @__PURE__ */ icon(PhPackage, "Package");
export const PackageOpen = /* @__PURE__ */ icon(PhPackage, "PackageOpen");
export const PaintBucket = /* @__PURE__ */ icon(PhPaintBucket, "PaintBucket");
export const Palette = /* @__PURE__ */ icon(PhPalette, "Palette");
export const PanelLeft = /* @__PURE__ */ icon(PhSidebarSimple, "PanelLeft");
export const PanelsTopLeft = /* @__PURE__ */ icon(PhLayout, "PanelsTopLeft");
export const Paperclip = /* @__PURE__ */ icon(PhPaperclip, "Paperclip");
export const Pause = /* @__PURE__ */ icon(PhPause, "Pause");
export const Pencil = /* @__PURE__ */ icon(PhPencil, "Pencil");
export const PencilOff = /* @__PURE__ */ icon(PhPencilSlash, "PencilOff");
export const PencilRuler = /* @__PURE__ */ icon(PhPencilRuler, "PencilRuler");
export const PersonStanding = /* @__PURE__ */ icon(PhPerson, "PersonStanding");
export const Pin = /* @__PURE__ */ icon(PhPushPin, "Pin");
export const Pipette = /* @__PURE__ */ icon(PhEyedropper, "Pipette");
export const Pizza = /* @__PURE__ */ icon(PhPizza, "Pizza");
export const Play = /* @__PURE__ */ icon(PhPlay, "Play");
export const Plug = /* @__PURE__ */ icon(PhPlug, "Plug");
export const Plus = /* @__PURE__ */ icon(PhPlus, "Plus");
export const Power = /* @__PURE__ */ icon(PhPower, "Power");
export const Puzzle = /* @__PURE__ */ icon(PhPuzzlePiece, "Puzzle");
export const QrCode = /* @__PURE__ */ icon(PhQrCode, "QrCode");
export const Radio = /* @__PURE__ */ icon(PhBroadcast, "Radio");
export const Radius = /* @__PURE__ */ icon(PhBoundingBox, "Radius");
export const RectangleHorizontal = /* @__PURE__ */ icon(PhRectangle, "RectangleHorizontal");
export const RectangleVertical = /* @__PURE__ */ icon(PhRectangle, "RectangleVertical");
export const Redo2 = /* @__PURE__ */ icon(PhArrowUUpRight, "Redo2");
export const RefreshCw = /* @__PURE__ */ icon(PhArrowsClockwise, "RefreshCw");
export const Repeat = /* @__PURE__ */ icon(PhRepeat, "Repeat");
export const Rotate3d = /* @__PURE__ */ icon(PhArrowsClockwise, "Rotate3d");
export const RotateCcw = /* @__PURE__ */ icon(PhArrowCounterClockwise, "RotateCcw");
export const Route = /* @__PURE__ */ icon(PhPath, "Route");
export const Rows3 = /* @__PURE__ */ icon(PhRows, "Rows3");
export const Save = /* @__PURE__ */ icon(PhFloppyDisk, "Save");
export const Scale3d = /* @__PURE__ */ icon(PhResize, "Scale3d");
export const ScanEye = /* @__PURE__ */ icon(PhScan, "ScanEye");
export const Scissors = /* @__PURE__ */ icon(PhScissors, "Scissors");
export const ScrollText = /* @__PURE__ */ icon(PhScroll, "ScrollText");
export const Search = /* @__PURE__ */ icon(PhMagnifyingGlass, "Search");
export const Settings = /* @__PURE__ */ icon(PhGear, "Settings");
export const Settings2 = /* @__PURE__ */ icon(PhGearSix, "Settings2");
export const Shapes = /* @__PURE__ */ icon(PhShapes, "Shapes");
export const Share2 = /* @__PURE__ */ icon(PhShareNetwork, "Share2");
export const ShieldAlert = /* @__PURE__ */ icon(PhShieldWarning, "ShieldAlert");
export const ShieldCheck = /* @__PURE__ */ icon(PhShieldCheck, "ShieldCheck");
export const ShieldPlus = /* @__PURE__ */ icon(PhShieldPlus, "ShieldPlus");
export const Shuffle = /* @__PURE__ */ icon(PhShuffle, "Shuffle");
export const Sliders = /* @__PURE__ */ icon(PhSliders, "Sliders");
export const SlidersHorizontal = /* @__PURE__ */ icon(PhSlidersHorizontal, "SlidersHorizontal");
export const Smartphone = /* @__PURE__ */ icon(PhDeviceMobile, "Smartphone");
export const Sparkles = /* @__PURE__ */ icon(PhSparkle, "Sparkles");
export const Spline = /* @__PURE__ */ icon(PhBezierCurve, "Spline");
export const Square = /* @__PURE__ */ icon(PhSquare, "Square");
export const SquareDashed = /* @__PURE__ */ icon(PhSelectionPlus, "SquareDashed", "bold");
export const SquareDot = /* @__PURE__ */ icon(PhSquareLogo, "SquareDot");
export const SquareMinus = /* @__PURE__ */ icon(PhMinusSquare, "SquareMinus");
export const SquarePlus = /* @__PURE__ */ icon(PhPlusSquare, "SquarePlus");
export const SquareStack = /* @__PURE__ */ icon(PhStack, "SquareStack");
export const SquareTerminal = /* @__PURE__ */ icon(PhTerminalWindow, "SquareTerminal");
export const SquareX = /* @__PURE__ */ icon(PhXSquare, "SquareX");
export const Stamp = /* @__PURE__ */ icon(PhStamp, "Stamp");
export const StepForward = /* @__PURE__ */ icon(PhSkipForward, "StepForward");
export const StickyNote = /* @__PURE__ */ icon(PhNote, "StickyNote");
export const Store = /* @__PURE__ */ icon(PhStorefront, "Store");
export const Sun = /* @__PURE__ */ icon(PhSun, "Sun");
export const Swords = /* @__PURE__ */ icon(PhSword, "Swords");
export const Tag = /* @__PURE__ */ icon(PhTag, "Tag");
export const Target = /* @__PURE__ */ icon(PhTarget, "Target");
export const Terminal = /* @__PURE__ */ icon(PhTerminal, "Terminal");
export const TerminalSquare = /* @__PURE__ */ icon(PhTerminalWindow, "TerminalSquare");
export const TextCursorInput = /* @__PURE__ */ icon(PhTextbox, "TextCursorInput");
export const Trash2 = /* @__PURE__ */ icon(PhTrash, "Trash2");
export const Triangle = /* @__PURE__ */ icon(PhTriangle, "Triangle");
export const TriangleAlert = /* @__PURE__ */ icon(PhWarning, "TriangleAlert");
export const TriangleRight = /* @__PURE__ */ icon(PhCaretRight, "TriangleRight", "bold");
export const Type = /* @__PURE__ */ icon(PhTextT, "Type");
export const Undo2 = /* @__PURE__ */ icon(PhArrowUUpLeft, "Undo2");
export const Unlink = /* @__PURE__ */ icon(PhLinkBreak, "Unlink");
export const Unlock = /* @__PURE__ */ icon(PhLockOpen, "Unlock");
export const UploadCloud = /* @__PURE__ */ icon(PhCloudArrowUp, "UploadCloud");
export const Video = /* @__PURE__ */ icon(PhVideoCamera, "Video");
export const Volume2 = /* @__PURE__ */ icon(PhSpeakerHigh, "Volume2");
export const VolumeX = /* @__PURE__ */ icon(PhSpeakerSlash, "VolumeX");
export const Wand2 = /* @__PURE__ */ icon(PhMagicWand, "Wand2");
export const WandSparkles = /* @__PURE__ */ icon(PhMagicWand, "WandSparkles");
export const Waves = /* @__PURE__ */ icon(PhWaves, "Waves");
export const Waypoints = /* @__PURE__ */ icon(PhPath, "Waypoints");
export const Wifi = /* @__PURE__ */ icon(PhWifiHigh, "Wifi");
export const Wind = /* @__PURE__ */ icon(PhWind, "Wind");
export const Workflow = /* @__PURE__ */ icon(PhFlowArrow, "Workflow");
export const WrapText = /* @__PURE__ */ icon(PhTextAlignLeft, "WrapText");
export const X = /* @__PURE__ */ icon(PhX, "X");
export const Zap = /* @__PURE__ */ icon(PhLightning, "Zap");
export const ZoomIn = /* @__PURE__ */ icon(PhMagnifyingGlassPlus, "ZoomIn");
export const ZoomOut = /* @__PURE__ */ icon(PhMagnifyingGlassMinus, "ZoomOut");
