// Configure the shared rendering module once. No native imports reach its web build.
import { configureRenderRuntime } from '../../../share-service/renderer/runtime';
import { useAppStore } from '../../store/useAppStore';
import { toDisplaySrc } from '../imagePath';
import { copyText, readClipboardText } from '../clipboard';
import { openLinkTargetSafe } from '../codemirror/linkClick';
import { openImagePrompt, openResourcePrompt } from '../codemirror/markdownActions';
import { runBlock } from '../codeRun/runBlock';
configureRenderRuntime({ resolveResource: toDisplaySrc, copyText, readClipboardText, openLink: openLinkTargetSafe, openImagePrompt, openResourcePrompt, runBlock, app: useAppStore });
