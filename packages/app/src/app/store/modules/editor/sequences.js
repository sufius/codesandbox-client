import { set, when, equals, toggle, increment } from 'cerebral/operators';
import { state, props, string } from 'cerebral/tags';
import * as actions from './actions';
import { closeTabByIndex } from '../../actions';
import { renameModule } from '../files/sequences';
import {
  sendModuleSaved,
  getSelectionsForCurrentModule,
  sendChangeCurrentModule,
  setReceivingStatus,
  getCodeOperation,
  sendTransform,
  unSetReceivingStatus,
} from '../live/actions';
import {
  ensureOwnedSandbox,
  forkSandbox,
  fetchGitChanges,
  closeModal,
} from '../../sequences';

import { setCurrentModule, addNotification, track } from '../../factories';

export const openQuickActions = set(state`editor.quickActionsOpen`, true);

export const closeQuickActions = set(state`editor.quickActionsOpen`, false);

export const toggleProjectView = toggle(state`editor.isInProjectView`);

const hasEnoughTabs = when(state`editor.tabs`, tabs => tabs.length > 1);

export const closeTab = [
  hasEnoughTabs,
  {
    false: [],
    true: [closeTabByIndex, actions.setCurrentModuleByTab],
  },
];

export const clearErrors = [
  set(state`editor.errors`, []),
  set(state`editor.corrections`, []),
  set(state`editor.glyphs`, []),
];

export const moveTab = actions.moveTab;

export const onUnload = actions.warnUnloadingContent;

export const startResizing = set(state`editor.isResizing`, true);

export const stopResizing = set(state`editor.isResizing`, false);

export const createZip = actions.createZip;

export const changeCurrentModule = [
  track('Open File', {}),
  setReceivingStatus,
  setCurrentModule(props`id`),
  equals(state`live.isLive`),
  {
    true: [
      equals(state`live.isCurrentEditor`),
      {
        true: [
          getSelectionsForCurrentModule,
          set(state`editor.pendingUserSelections`, props`selections`),
          sendChangeCurrentModule,
        ],
        false: [],
      },
    ],
    false: [],
  },
];

export const changeCurrentTab = [set(state`editor.currentTabId`, props`tabId`)];

export const unsetDirtyTab = actions.unsetDirtyTab;

export const updatePrivacy = [
  actions.ensureValidPrivacy,
  {
    valid: [
      set(state`editor.isUpdatingPrivacy`, true),
      actions.updatePrivacy,
      set(state`editor.isUpdatingPrivacy`, false),
    ],
    invalid: [],
  },
];

export const toggleLikeSandbox = [
  when(state`editor.sandboxes.${props`id`}.userLiked`),
  {
    true: [
      actions.unlikeSandbox,
      increment(state`editor.sandboxes.${props`id`}.likeCount`, -1),
    ],
    false: [
      actions.likeSandbox,
      increment(state`editor.sandboxes.${props`id`}.likeCount`, 1),
    ],
  },
  toggle(state`editor.sandboxes.${props`id`}.userLiked`),
];

export const forceForkSandbox = [
  when(state`editor.currentSandbox.owned`),
  {
    true: [
      actions.confirmForkingOwnSandbox,
      {
        confirmed: forkSandbox,
        cancelled: [],
      },
    ],
    false: forkSandbox,
  },
];

export const changeCode = [
  track('Change Code', {}, { trackOnce: true }),
  actions.setCode,
  actions.addChangedModule,
  actions.unsetDirtyTab,
];

export const saveChangedModules = [
  track('Save Modified Modules', {}),
  ensureOwnedSandbox,
  actions.outputChangedModules,
  actions.saveChangedModules,
  actions.removeChangedModules,
  when(state`editor.currentSandbox.originalGit`),
  {
    true: [
      when(state`workspace.openedWorkspaceItem`, item => item === 'github'),
      {
        true: fetchGitChanges,
        false: [],
      },
    ],
    false: [],
  },
];

export const saveCode = [
  track('Save Code', {}),
  ensureOwnedSandbox,
  when(props`code`),
  {
    true: actions.setCode,
    false: [],
  },
  when(state`preferences.settings.prettifyOnSaveEnabled`),
  {
    true: [
      actions.prettifyCode,
      {
        success: actions.setCode,
        error: [],
      },
    ],
    false: [],
  },
  actions.saveModuleCode,
  actions.setModuleSaved,
  when(state`editor.currentSandbox.originalGit`),
  {
    true: [
      when(state`workspace.openedWorkspaceItem`, item => item === 'github'),
      {
        true: fetchGitChanges,
        false: [],
      },
    ],
    false: [],
  },
  sendModuleSaved,
];

export const discardModuleChanges = [
  track('Code Discarded', {}),
  actions.getSavedCode,
  when(props`code`),
  {
    true: [
      equals(state`live.isLive`),
      {
        true: [
          setReceivingStatus,
          getCodeOperation,
          sendTransform,
          changeCode,
          unSetReceivingStatus,
        ],
        false: [changeCode],
      },
    ],
    false: [],
  },
];

export const addNpmDependency = [
  track('Add NPM Dependency', {}),
  closeModal,
  ensureOwnedSandbox,
  when(props`version`),
  {
    true: [],
    false: [actions.getLatestVersion],
  },
  actions.addNpmDependencyToPackage,
  equals(state`live.isLive`),
  {
    true: [
      setReceivingStatus,
      getCodeOperation,
      sendTransform,
      saveCode,
      unSetReceivingStatus,
    ],
    false: [saveCode],
  },
];

export const removeNpmDependency = [
  track('Remove NPM Dependency', {}),
  ensureOwnedSandbox,
  actions.removeNpmDependencyFromPackage,
  equals(state`live.isLive`),
  {
    true: [
      setReceivingStatus,
      getCodeOperation,
      sendTransform,
      saveCode,
      unSetReceivingStatus,
    ],
    false: [saveCode],
  },
];

export const updateSandboxPackage = [actions.updateSandboxPackage, saveCode];

export const handlePreviewAction = [
  equals(props`action.action`),
  {
    notification: addNotification(
      props`action.title`,
      props`action.notificationType`,
      props`action.timeAlive`
    ),
    'show-error': actions.addErrorFromPreview,
    'show-correction': actions.addCorrectionFromPreview,
    'show-glyph': actions.addGlyphFromPreview,
    'source.module.rename': [
      actions.consumeRenameModuleFromPreview,
      renameModule,
    ],
    'source.dependencies.add': [
      set(props`name`, props`action.dependency`),
      addNpmDependency,
      actions.forceRender,
    ],
    'editor.open-module': [
      actions.outputModuleIdFromActionPath,
      when(props`id`),
      {
        true: setCurrentModule(props`id`),
        false: [],
      },
    ],
    otherwise: [],
  },
];

export const setPreviewBounds = [actions.setPreviewBounds];

export const setPreviewContent = [
  set(state`editor.previewWindow.content`, props`content`),
];

export const prettifyCode = [
  track('Prettify Code', {}),
  actions.prettifyCode,
  {
    success: [changeCode],
    invalidPrettierSandboxConfig: addNotification(
      'Invalid JSON in sandbox .prettierrc file',
      'error'
    ),
    error: addNotification(
      string`Something went wrong prettifying the code: "${props`error.message`}"`,
      'error'
    ),
  },
];
