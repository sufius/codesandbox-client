// @flow
import * as React from 'react';
import { TextOperation } from 'ot';
import { debounce } from 'lodash-es';
import { getModulePath } from 'common/sandbox/modules';
import { css } from 'glamor';
import { listen } from 'codesandbox-api';

import getTemplate from 'common/templates';
import type {
  Module,
  Sandbox,
  ModuleError,
  ModuleCorrection,
  Directory,
} from 'common/types';

/* eslint-disable import/no-webpack-loader-syntax */
import SyntaxHighlightWorker from 'worker-loader?publicPath=/&name=monaco-syntax-highlighter.[hash:8].worker.js!./workers/syntax-highlighter';
import LinterWorker from 'worker-loader?publicPath=/&name=monaco-linter.[hash:8].worker.js!./workers/linter';
import TypingsFetcherWorker from 'worker-loader?publicPath=/&name=monaco-typings-ata.[hash:8].worker.js!./workers/fetch-dependency-typings';
/* eslint-enable import/no-webpack-loader-syntax */

import MonacoEditorComponent from './MonacoReactComponent';
import FuzzySearch from '../FuzzySearch';
import { Container, CodeContainer } from './elements';
import defineTheme from './define-theme';
import getSettings from './settings';

import type { Props, Editor } from '../types';
import getMode from './mode';

type State = {
  fuzzySearchEnabled: boolean,
};

function indexToLineAndColumn(lines, index) {
  let offset = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (offset + line.length + 1 > index) {
      return {
        lineNumber: i + 1,
        column: index - offset + 1,
      };
    }

    // + 1 is for the linebreak character which is not included
    offset += line.length + 1;
  }

  // +2 for column (length is already a +1), because +1 for Monaco and +1 for linebreak
  return {
    lineNumber: lines.length,
    column: (lines[lines.length - 1] || '').length + 1,
  };
}

const fadeIn = css.keyframes('fadeIn', {
  // optional name
  '0%': { opacity: 0 },
  '100%': { opacity: 1 },
});

const fadeOut = css.keyframes('fadeOut', {
  // optional name
  '0%': { opacity: 1 },
  '100%': { opacity: 0 },
});

function lineAndColumnToIndex(lines, lineNumber, column) {
  let currentLine = 0;
  let index = 0;

  while (currentLine + 1 < lineNumber) {
    index += lines[currentLine].length;
    index += 1; // Linebreak character
    currentLine += 1;
  }

  index += column - 1;

  return index;
}

function getSelection(lines, selection) {
  const startSelection = lineAndColumnToIndex(
    lines,
    selection.startLineNumber,
    selection.startColumn
  );
  const endSelection = lineAndColumnToIndex(
    lines,
    selection.endLineNumber,
    selection.endColumn
  );

  return {
    selection:
      startSelection === endSelection ? [] : [startSelection, endSelection],
    cursorPosition: lineAndColumnToIndex(
      lines,
      selection.positionLineNumber,
      selection.positionColumn
    ),
  };
}

let modelCache = {};

class MonacoEditor extends React.Component<Props, State> implements Editor {
  static defaultProps = {
    width: '100%',
    height: '100%',
  };

  sandbox: $PropertyType<Props, 'sandbox'>;
  currentModule: $PropertyType<Props, 'currentModule'>;
  settings: $PropertyType<Props, 'settings'>;
  dependencies: ?$PropertyType<Props, 'dependencies'>;
  tsconfig: ?$PropertyType<Props, 'tsconfig'>;
  disposeInitializer: ?() => void;
  syntaxWorker: ?Worker;
  lintWorker: ?Worker;
  typingsFetcherWorker: ?Worker;
  sizeProbeInterval: ?number;
  editor: any;
  monaco: any;
  receivingCode: ?boolean = false;
  transpilationListener: ?Function;

  constructor(props: Props) {
    super(props);
    this.state = {
      fuzzySearchEnabled: false,
    };
    this.sandbox = props.sandbox;
    this.currentModule = props.currentModule;
    this.settings = props.settings;
    this.dependencies = props.dependencies;

    this.tsconfig = props.tsconfig;

    this.syntaxWorker = null;
    this.lintWorker = null;
    this.typingsFetcherWorker = null;
    this.sizeProbeInterval = null;

    this.resizeEditor = debounce(this.resizeEditor, 500);
    this.commitLibChanges = debounce(this.commitLibChanges, 300);
    this.onSelectionChangedDebounced = debounce(
      this.onSelectionChangedDebounced,
      500
    );

    this.transpilationListener = this.setupTranspilationListener();
  }

  shouldComponentUpdate(nextProps: Props) {
    if (
      this.props.width !== nextProps.width ||
      this.props.height !== nextProps.height
    ) {
      this.resizeEditor();
    }

    if (this.props.readOnly !== nextProps.readOnly && this.editor) {
      this.editor.updateOptions({ readOnly: !!nextProps.readOnly });
    }
    return false;
  }

  componentWillUnmount() {
    window.removeEventListener('resize', this.resizeEditor);
    // Make sure that everything has run before disposing, to prevent any inconsistensies
    setTimeout(() => {
      this.disposeModules(this.sandbox.modules);
      if (this.editor) {
        this.editor.dispose();
      }
      if (this.syntaxWorker) {
        this.syntaxWorker.terminate();
      }
      if (this.lintWorker) {
        this.lintWorker.terminate();
      }
      if (this.typingsFetcherWorker) {
        this.typingsFetcherWorker.terminate();
      }
      if (this.transpilationListener) {
        this.transpilationListener();
      }
      clearTimeout(this.sizeProbeInterval);
    });

    if (this.disposeInitializer) {
      this.disposeInitializer();
    }
  }

  setupTranspilationListener() {
    return listen(({ type, code, path }) => {
      if (type === 'add-extra-lib') {
        const dtsPath = `${path}.d.ts`;
        this.monaco.languages.typescript.typescriptDefaults._extraLibs[
          `file:///${dtsPath}`
        ] = code;
        this.commitLibChanges();
      }
    });
  }

  configureEditor = async (editor: any, monaco: any) => {
    this.editor = editor;
    this.monaco = monaco;

    // eslint-disable-next-line no-underscore-dangle
    window._cs = {
      editor: this.editor,
      monaco: this.monaco,
    };

    requestAnimationFrame(() => {
      this.setupWorkers();
      editor.onDidChangeModelContent(e => {
        const { isLive, sendTransforms } = this.props;

        if (isLive && sendTransforms && !this.receivingCode) {
          this.sendChangeOperations(e);
        }

        this.handleChange();
      });
    });

    monaco.languages.typescript.typescriptDefaults.setMaximunWorkerIdleTime(-1);
    monaco.languages.typescript.javascriptDefaults.setMaximunWorkerIdleTime(-1);

    monaco.languages.typescript.typescriptDefaults.setEagerModelSync(true);
    monaco.languages.typescript.javascriptDefaults.setEagerModelSync(true);

    this.setCompilerOptions();

    const sandbox = this.sandbox;
    const currentModule = this.currentModule;

    await this.initializeModules(sandbox.modules);
    await this.openNewModel(currentModule.id, currentModule.title);

    import(/* webpackChunkName: 'monaco-emmet' */ './enable-emmet').then(
      enableEmmet => {
        enableEmmet.default(editor, monaco, {});
      }
    );

    window.addEventListener('resize', this.resizeEditor);
    this.sizeProbeInterval = setInterval(this.resizeEditor.bind(this), 3000);

    const { dependencies } = this;
    if (dependencies != null) {
      if (Object.keys(dependencies)) {
        setTimeout(() => {
          this.fetchDependencyTypings(dependencies);
          this.getConfigSchemas();
        }, this.hasNativeTypescript() ? 500 : 5000);
      }
    }

    editor.addAction({
      // An unique identifier of the contributed action.
      id: 'fuzzy-search',

      // A label of the action that will be presented to the user.
      label: 'Open Module',

      // An optional array of keybindings for the action.
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KEY_P], // eslint-disable-line no-bitwise

      // A precondition for this action.
      precondition: null,

      // A rule to evaluate on top of the precondition in order to dispatch the keybindings.
      keybindingContext: null,

      contextMenuGroupId: 'navigation',

      contextMenuOrder: 1.5,

      // Method that will be executed when the action is triggered.
      // @param editor The editor instance is passed in as a convinience
      run: () => {
        this.setState(
          {
            fuzzySearchEnabled: true,
          },
          () => this.forceUpdate()
        );
      },
    });

    editor.onDidChangeCursorSelection(selectionChange => {
      // TODO: add another debounced action to send the current data. So we can
      // have the correct cursor pos no matter what
      const { onSelectionChanged, isLive } = this.props;
      // Reason 3 is update by mouse or arrow keys
      if (isLive) {
        const lines = editor.getModel().getLinesContent() || [];
        const data = {
          primary: getSelection(lines, selectionChange.selection),
          secondary: selectionChange.secondarySelections.map(s =>
            getSelection(lines, s)
          ),
        };
        if (
          (selectionChange.reason === 3 ||
            /* alt + shift + arrow keys */ selectionChange.source ===
              'moveWordCommand' ||
            /* click inside a selection */ selectionChange.source === 'api') &&
          onSelectionChanged
        ) {
          this.onSelectionChangedDebounced.cancel();
          onSelectionChanged({
            selection: data,
            moduleShortid: this.currentModule.shortid,
          });
        } else {
          // This is just on typing, we send a debounced selection update as a
          // safeguard to make sure we are in sync
          this.onSelectionChangedDebounced({
            selection: data,
            moduleShortid: this.currentModule.shortid,
          });
        }
      }
    });

    if (this.props.onInitialized) {
      this.disposeInitializer = this.props.onInitialized(this);
    }

    // TODO remove this as soon as we solve the keybinding issues
    editor.addCommand(
      // eslint-disable-next-line
      this.monaco.KeyMod.CtrlCmd | this.monaco.KeyCode.KEY_S,
      () => {
        const { onSave } = this.props;
        if (onSave) {
          onSave(this.getCode());
        }
      }
    );
  };

  setCompilerOptions = () => {
    const hasNativeTypescript = this.hasNativeTypescript();
    const existingConfig = this.tsconfig ? this.tsconfig.compilerOptions : {};

    const compilerDefaults = {
      jsxFactory: 'React.createElement',
      reactNamespace: 'React',
      jsx: this.monaco.languages.typescript.JsxEmit.React,
      target: this.monaco.languages.typescript.ScriptTarget.ES2016,
      allowNonTsExtensions: !hasNativeTypescript,
      moduleResolution: this.monaco.languages.typescript.ModuleResolutionKind
        .NodeJs,
      module: hasNativeTypescript
        ? this.monaco.languages.typescript.ModuleKind.ES2015
        : this.monaco.languages.typescript.ModuleKind.System,
      experimentalDecorators: true,
      noEmit: true,
      allowJs: true,
      typeRoots: ['node_modules/@types'],

      forceConsistentCasingInFileNames:
        hasNativeTypescript && existingConfig.forceConsistentCasingInFileNames,
      noImplicitReturns:
        hasNativeTypescript && existingConfig.noImplicitReturns,
      noImplicitThis: hasNativeTypescript && existingConfig.noImplicitThis,
      noImplicitAny: hasNativeTypescript && existingConfig.noImplicitAny,
      strictNullChecks: hasNativeTypescript && existingConfig.strictNullChecks,
      suppressImplicitAnyIndexErrors:
        hasNativeTypescript && existingConfig.suppressImplicitAnyIndexErrors,
      noUnusedLocals: hasNativeTypescript && existingConfig.noUnusedLocals,

      newLine: this.monaco.languages.typescript.NewLineKind.LineFeed,
    };

    this.monaco.languages.typescript.typescriptDefaults.setCompilerOptions(
      compilerDefaults
    );
    this.monaco.languages.typescript.javascriptDefaults.setCompilerOptions(
      compilerDefaults
    );

    this.monaco.languages.typescript.typescriptDefaults.setDiagnosticsOptions({
      noSemanticValidation: false,
      noSyntaxValidation: !hasNativeTypescript,
    });
  };

  setReceivingCode = (receiving: boolean) => {
    this.receivingCode = receiving;
  };

  setTSConfig = (config: Object) => {
    this.tsconfig = config;

    this.setCompilerOptions();
  };

  changeModule = (
    newModule: Module,
    errors?: Array<ModuleError>,
    corrections?: Array<ModuleCorrection>
  ) => {
    const oldModule = this.currentModule;

    this.currentModule = newModule;
    this.swapDocuments({
      currentId: oldModule.id,
      nextId: newModule.id,
      nextTitle: newModule.title,
    }).then(() => {
      // Mark as receiving code so we don't send operations to others because
      // of a module switch
      this.receivingCode = true;
      if (newModule === this.currentModule) {
        this.changeCode(newModule.code || '');
      }

      if (errors) {
        this.setErrors(errors);
      }

      if (corrections) {
        this.setCorrections(corrections);
      }

      this.receivingCode = false;
      if (this.props.onCodeReceived) {
        // Whenever the user changes a module we set up a state that defines
        // that the changes of code are not sent to live users. We need to reset
        // this state when we're doing changing modules
        this.props.onCodeReceived();
        this.liveOperationCode = '';
      }
    });
  };

  onSelectionChangedDebounced = data => {
    if (this.props.onSelectionChanged) {
      this.props.onSelectionChanged(data);
    }
  };

  liveOperationCode = '';
  sendChangeOperations = changeEvent => {
    const { sendTransforms, isLive, onCodeReceived } = this.props;

    if (sendTransforms && changeEvent.changes) {
      const otOperation = new TextOperation();
      // TODO: add a comment explaining what "delta" is
      let delta = 0;

      this.liveOperationCode =
        this.liveOperationCode || this.currentModule.code || '';
      // eslint-disable-next-line no-restricted-syntax
      for (const change of [...changeEvent.changes].reverse()) {
        const cursorStartOffset =
          lineAndColumnToIndex(
            this.liveOperationCode.split(/\r?\n/),
            change.range.startLineNumber,
            change.range.startColumn
          ) + delta;

        const retain = cursorStartOffset - otOperation.targetLength;
        if (retain > 0) {
          otOperation.retain(retain);
        }

        if (change.rangeLength > 0) {
          otOperation.delete(change.rangeLength);
          delta -= change.rangeLength;
        }

        if (change.text) {
          otOperation.insert(change.text);
          delta += change.text.length;
        }
      }

      const remaining = this.liveOperationCode.length - otOperation.baseLength;
      if (remaining > 0) {
        otOperation.retain(remaining);
      }
      this.liveOperationCode = otOperation.apply(this.liveOperationCode);

      sendTransforms(otOperation);

      requestAnimationFrame(() => {
        this.liveOperationCode = '';
      });
    } else if (!isLive && onCodeReceived) {
      onCodeReceived();
    }
  };

  userClassesGenerated = {};
  userSelectionDecorations = {};
  updateUserSelections = (
    userSelections: Array<
      | {
          userId: string,
          selection: null,
        }
      | {
          userId: string,
          name: string,
          selection: any,
          color: Array<number>,
        }
    >
  ) => {
    const lines = this.editor.getModel().getLinesContent() || [];

    userSelections.forEach(data => {
      const { userId } = data;

      const decorationId = this.currentModule.shortid + userId;
      if (data.selection === null) {
        this.userSelectionDecorations[
          decorationId
        ] = this.editor.deltaDecorations(
          this.userSelectionDecorations[decorationId] || [],
          [],
          data.userId
        );

        return;
      }

      const decorations = [];
      const { selection, color, name } = data;

      if (selection) {
        const addCursor = (position, className) => {
          const cursorPos = indexToLineAndColumn(lines, position);

          decorations.push({
            range: new this.monaco.Range(
              cursorPos.lineNumber,
              cursorPos.column,
              cursorPos.lineNumber,
              cursorPos.column
            ),
            options: {
              className: this.userClassesGenerated[className],
            },
          });
        };

        const addSelection = (start, end, className) => {
          const from = indexToLineAndColumn(lines, start);
          const to = indexToLineAndColumn(lines, end);

          decorations.push({
            range: new this.monaco.Range(
              from.lineNumber,
              from.column,
              to.lineNumber,
              to.column
            ),
            options: {
              className: this.userClassesGenerated[className],
            },
          });
        };

        const prefix = color.join('-') + userId;
        const cursorClassName = prefix + '-cursor';
        const secondaryCursorClassName = prefix + '-secondary-cursor';
        const selectionClassName = prefix + '-selection';
        const secondarySelectionClassName = prefix + '-secondary-selection';

        if (!this.userClassesGenerated[cursorClassName]) {
          const nameStyles = {
            content: name,
            position: 'absolute',
            top: -17,
            backgroundColor: `rgb(${color[0]}, ${color[1]}, ${color[2]})`,
            zIndex: 20,
            color:
              color[0] + color[1] + color[2] > 500
                ? 'rgba(0, 0, 0, 0.8)'
                : 'white',
            padding: '2px 4px',
            borderRadius: 2,
            borderBottomLeftRadius: 0,
            fontSize: '.75rem',
            fontWeight: 600,
            userSelect: 'none',
            pointerEvents: 'none',
            width: 'max-content',
          };
          this.userClassesGenerated[cursorClassName] = `${css({
            backgroundColor: `rgba(${color[0]}, ${color[1]}, ${color[2]}, 0.8)`,
            width: '2px !important',
            cursor: 'text',
            zIndex: 30,
            ':before': {
              animation: `${fadeOut} 0.3s`,
              animationDelay: '1s',
              animationFillMode: 'forwards',
              opacity: 1,
              ...nameStyles,
            },
            ':hover': {
              ':before': {
                animation: `${fadeIn} 0.3s`,
                animationFillMode: 'forwards',
                opacity: 0,
                ...nameStyles,
              },
            },
          })}`;
        }

        if (!this.userClassesGenerated[secondaryCursorClassName]) {
          this.userClassesGenerated[secondaryCursorClassName] = `${css({
            backgroundColor: `rgba(${color[0]}, ${color[1]}, ${color[2]}, 0.6)`,
            width: '2px !important',
          })}`;
        }

        if (!this.userClassesGenerated[selectionClassName]) {
          this.userClassesGenerated[selectionClassName] = `${css({
            backgroundColor: `rgba(${color[0]}, ${color[1]}, ${color[2]}, 0.3)`,
            borderRadius: '3px',
            minWidth: 7.6,
          })}`;
        }

        if (!this.userClassesGenerated[secondarySelectionClassName]) {
          this.userClassesGenerated[secondarySelectionClassName] = `${css({
            backgroundColor: `rgba(${color[0]}, ${color[1]}, ${color[2]}, 0.2)`,
            borderRadius: '3px',
            minWidth: 7.6,
          })}`;
        }

        addCursor(selection.primary.cursorPosition, cursorClassName);
        if (selection.primary.selection.length) {
          addSelection(
            selection.primary.selection[0],
            selection.primary.selection[1],
            selectionClassName
          );
        }

        if (selection.secondary.length) {
          selection.secondary.forEach(s => {
            addCursor(s.cursorPosition, secondaryCursorClassName);

            if (s.selection.length) {
              addSelection(
                s.selection[0],
                s.selection[1],
                secondarySelectionClassName
              );
            }
          });
        }
      }

      // Allow new model to attach in case it's attaching
      requestAnimationFrame(() => {
        this.userSelectionDecorations[
          decorationId
        ] = this.editor.deltaDecorations(
          this.userSelectionDecorations[decorationId] || [],
          decorations,
          userId
        );
      });
    });
  };

  changeSandbox = (
    newSandbox: Sandbox,
    newCurrentModule: Module,
    dependencies: $PropertyType<Props, 'dependencies'>
  ): Promise<null> =>
    new Promise(resolve => {
      const oldSandbox = this.sandbox;

      this.sandbox = newSandbox;
      this.currentModule = newCurrentModule;
      this.dependencies = dependencies;

      // Reset models, dispose old ones
      this.disposeModules(oldSandbox.modules);

      // Do in setTimeout, since disposeModules is async
      setTimeout(() => {
        this.getConfigSchemas();
        // Initialize new models
        this.initializeModules(newSandbox.modules)
          .then(() =>
            this.openNewModel(newCurrentModule.id, newCurrentModule.title)
          )
          .then(resolve);
      });
    });

  changeCode = (code: string) => {
    if (code !== this.getCode()) {
      this.updateCode(code);
      this.syntaxHighlight(
        code,
        this.currentModule.title,
        this.editor.getModel().getVersionId()
      );
      this.lint(
        code,
        this.currentModule.title,
        this.editor.getModel().getVersionId()
      );
    }
  };

  applyOperation = (operation: any) => {
    this.liveOperationCode = '';
    let index = 0;
    for (let i = 0; i < operation.ops.length; i++) {
      const op = operation.ops[i];
      if (TextOperation.isRetain(op)) {
        index += op;
      } else if (TextOperation.isInsert(op)) {
        const { lineNumber, column } = indexToLineAndColumn(
          this.editor.getModel().getLinesContent() || [],
          index
        );
        this.editor.getModel().applyEdits([
          {
            range: new this.monaco.Range(
              lineNumber,
              column,
              lineNumber,
              column
            ),
            text: op,
            forceMoveMarkers: true,
          },
        ]);
        index += op.length;
      } else if (TextOperation.isDelete(op)) {
        const lines = this.editor.getModel().getLinesContent() || [];
        const from = indexToLineAndColumn(lines, index);
        const to = indexToLineAndColumn(lines, index - op);
        this.editor.getModel().applyEdits([
          {
            range: new this.monaco.Range(
              from.lineNumber,
              from.column,
              to.lineNumber,
              to.column
            ),
            text: '',
          },
        ]);
      }
    }
  };

  changeDependencies = (
    dependencies: ?$PropertyType<Props, 'dependencies'>
  ) => {
    this.dependencies = dependencies;
    if (dependencies) {
      this.fetchDependencyTypings(dependencies);
    }
  };

  changeSettings = (settings: $PropertyType<Props, 'settings'>) => {
    this.settings = settings;
    if (settings.lintEnabled && !this.lintWorker) {
      this.setupLintWorker();
    }

    this.editor.updateOptions(this.getEditorOptions());
    this.forceUpdate();
  };

  updateModules = () => {
    const sandbox = this.sandbox;

    sandbox.modules.forEach(module => {
      if (modelCache[module.id] && modelCache[module.id].model) {
        const path = getModulePath(
          sandbox.modules,
          sandbox.directories,
          module.id
        );

        if (path === '') {
          // Parent dir got deleted
          this.disposeModel(module.id);
          return;
        }

        // Check for changed path, if that's
        // the case create a new model with corresponding tag, ditch the other model
        if (path !== modelCache[module.id].model.uri.path) {
          const isCurrentlyOpened =
            this.editor.getModel() === modelCache[module.id].model;

          if (isCurrentlyOpened) {
            // Unload model, we're going to dispose it
            this.editor.setModel(null);
          }

          this.disposeModel(module.id);

          this.createModel(module, sandbox.modules, sandbox.directories).then(
            newModel => {
              if (isCurrentlyOpened) {
                // Open it again if it was open
                this.editor.setModel(newModel);
              }
            }
          );
        }
      }
    });

    // Also check for deleted modules
    Object.keys(modelCache).forEach(moduleId => {
      // This module got deleted, dispose it
      if (!sandbox.modules.find(m => m.id === moduleId)) {
        this.disposeModel(moduleId);
      }
    });
  };

  setErrors = (errors: Array<ModuleError>) => {
    if (errors.length > 0) {
      const thisModuleErrors = errors.filter(
        error => error.moduleId === this.currentModule.id
      );
      const errorMarkers = thisModuleErrors
        .map(error => {
          if (error) {
            return {
              severity: this.monaco.Severity.Error,
              startColumn: 1,
              startLineNumber: error.line,
              endColumn: error.column,
              endLineNumber: error.line + 1,
              message: error.message,
            };
          }

          return null;
        })
        .filter(x => x);

      this.monaco.editor.setModelMarkers(
        this.editor.getModel(),
        'error',
        errorMarkers
      );
    } else {
      this.monaco.editor.setModelMarkers(this.editor.getModel(), 'error', []);
    }
  };

  setCorrections = (corrections: Array<ModuleCorrection>) => {
    if (corrections.length > 0) {
      const correctionMarkers = corrections
        .filter(correction => correction.moduleId === this.currentModule.id)
        .map(correction => {
          if (correction) {
            return {
              severity:
                correction.severity === 'warning'
                  ? this.monaco.Severity.Warning
                  : this.monaco.Severity.Notice,
              startColumn: correction.column,
              startLineNumber: correction.line,
              endColumn: 1,
              endLineNumber: correction.line + 1,
              message: correction.message,
              source: correction.source,
            };
          }

          return null;
        })
        .filter(x => x);

      this.monaco.editor.setModelMarkers(
        this.editor.getModel(),
        'correction',
        correctionMarkers
      );
    } else {
      this.monaco.editor.setModelMarkers(
        this.editor.getModel(),
        'correction',
        []
      );
    }
  };

  setGlyphs = (glyphs: Array<{ line: number, className: string }>) => {
    if (glyphs.length > 0) {
      const glyphMarkers = glyphs
        .map(glyph => {
          if (glyph) {
            return {
              range: new this.monaco.Range(glyph.line, 1, glyph.line, 1),
              options: {
                isWholeLine: true,
                glyphMarginClassName: glyph.className,
              },
            };
          }

          return null;
        })
        .filter(x => x);

      this.editor.deltaDecorations([], glyphMarkers);
    } else {
      this.editor.deltaDecorations([], []);
    }
  };

  setupTypeWorker = () => {
    this.typingsFetcherWorker = new TypingsFetcherWorker();
    const regex = /node_modules\/(@types\/.*?)\//;

    this.fetchDependencyTypings(this.dependencies || {});

    if (this.typingsFetcherWorker) {
      this.typingsFetcherWorker.addEventListener('message', event => {
        const sandbox = this.sandbox;
        const dependencies = this.dependencies || sandbox.npmDependencies;

        Object.keys(event.data).forEach((path: string) => {
          const typings = event.data[path];
          if (
            path.startsWith('node_modules/@types') &&
            this.hasNativeTypescript()
          ) {
            const match = path.match(regex);
            if (match && match[1]) {
              const dependency = match[1];

              if (
                !Object.keys(dependencies).includes(dependency) &&
                this.props.onNpmDependencyAdded
              ) {
                this.props.onNpmDependencyAdded(dependency);
              }
            }
          }

          this.addLib(typings, '/' + path);
        });
      });
    }
  };

  setupLintWorker = () => {
    this.lintWorker = new LinterWorker();

    this.lintWorker.addEventListener('message', event => {
      const { markers, version } = event.data;

      requestAnimationFrame(() => {
        if (this.editor.getModel()) {
          if (version === this.editor.getModel().getVersionId()) {
            this.updateLintWarnings(markers);
          } else {
            this.updateLintWarnings([]);
          }
        }
      });
    });

    this.lint = debounce(this.lint, 400);
  };

  setupSyntaxWorker = () => {
    this.syntaxWorker = new SyntaxHighlightWorker();

    this.syntaxWorker.addEventListener('message', event => {
      const { classifications, version } = event.data;

      requestAnimationFrame(() => {
        if (this.editor.getModel()) {
          if (version === this.editor.getModel().getVersionId()) {
            this.updateDecorations(classifications);
          }
        }
      });
    });
  };

  setupWorkers = () => {
    this.setupSyntaxWorker();
    const settings = this.settings;

    if (settings.lintEnabled) {
      // Delay this one, as initialization is very heavy
      setTimeout(() => {
        this.setupLintWorker();
      }, 5000);
    }

    if (settings.autoDownloadTypes) {
      this.setupTypeWorker();
    }
  };

  updateDecorations = async (classifications: Array<Object>) => {
    const decorations = classifications.map(classification => ({
      range: new this.monaco.Range(
        classification.startLine,
        classification.start,
        classification.endLine,
        classification.end
      ),
      options: {
        inlineClassName: classification.type
          ? `${classification.kind} ${classification.type}-of-${
              classification.parentKind
            }`
          : classification.kind,
      },
    }));

    const currentModule = this.currentModule;
    const modelInfo = await this.getModelById(currentModule.id);

    modelInfo.decorations = this.editor.deltaDecorations(
      modelInfo.decorations || [],
      decorations
    );
  };

  updateLintWarnings = async (markers: Array<Object>) => {
    const currentModule = this.currentModule;

    const mode = await getMode(currentModule.title, this.monaco);
    if (mode === 'javascript' || mode === 'vue') {
      this.monaco.editor.setModelMarkers(
        this.editor.getModel(),
        'eslint',
        markers
      );
    }
  };

  disposeModel = (id: string) => {
    if (modelCache[id]) {
      try {
        if (modelCache[id].model) {
          modelCache[id].model.dispose();
        }
        if (modelCache[id].lib) {
          modelCache[id].lib.dispose();
        }

        delete modelCache[id];
      } catch (e) {
        console.error(e);
      }
    }
  };

  swapDocuments = async ({
    currentId,
    nextId,
    nextTitle,
  }: {
    currentId: string,
    nextId: string,
    nextTitle: string,
  }) => {
    const pos = this.editor.getPosition();
    if (modelCache[currentId]) {
      const sandbox = this.sandbox;
      const currentModule = this.currentModule;
      const path = getModulePath(
        sandbox.modules,
        sandbox.directories,
        currentId
      );

      modelCache[currentId].cursorPos = pos;
      if (modelCache[currentId].lib) {
        // We let Monaco know what the latest code is of this file by removing
        // the old extraLib definition and defining a new one.
        modelCache[currentId].lib.dispose();
        modelCache[currentId].lib = this.addLib(currentModule.code || '', path);

        // Reset changes
        this.changes = { code: '', changes: [] };
      }
    }

    await this.openNewModel(nextId, nextTitle);
    this.editor.focus();
  };

  updateCode(code: string = '') {
    const pos = this.editor.getPosition();
    const lines = this.editor.getModel().getLinesContent() || [];
    const lastLine = lines.length;
    const lastLineColumn = (lines[lines.length - 1] || '').length;
    const editOperation = {
      identifier: {
        major: 1,
        minor: 1,
      },
      text: code,
      range: new this.monaco.Range(0, 0, lastLine + 1, lastLineColumn),
      forceMoveMarkers: false,
    };

    // For the live operation we need to send the operation based on the old code,
    // that's why we set the 'liveOperationCode' to the last code so the operation
    // will be applied on that code instead of `currentModule.code`
    this.liveOperationCode = this.getCode();

    this.editor.getModel().pushEditOperations([], [editOperation], null);
    this.editor.setPosition(pos);
  }

  syntaxHighlight = async (code: string, title: string, version: string) => {
    const mode = await getMode(title, this.monaco);
    if (mode === 'typescript' || mode === 'javascript') {
      if (this.syntaxWorker) {
        this.syntaxWorker.postMessage({
          code,
          title,
          version,
        });
      }
    }
  };

  lint = async (code: string, title: string, version: number) => {
    const mode = await getMode(title, this.monaco);
    if (this.settings.lintEnabled) {
      if (mode === 'javascript' || mode === 'vue') {
        if (this.lintWorker) {
          this.lintWorker.postMessage({
            code,
            title,
            version,
            template: this.sandbox.template,
          });
        }
      }
    }
  };

  handleChange = () => {
    const newCode = this.editor.getModel().getValue() || '';
    const currentModule = this.currentModule;
    const title = currentModule.title;

    const oldCode = this.currentModule.code || '';

    const codeEquals =
      oldCode.replace(/\r\n/g, '\n') === newCode.replace(/\r\n/g, '\n');

    if (!codeEquals) {
      if (this.props.onChange) {
        this.props.onChange(newCode);
      }

      this.syntaxHighlight(
        newCode,
        title,
        this.editor.getModel().getVersionId()
      );
      this.lint(newCode, title, this.editor.getModel().getVersionId());
    }
  };

  hasNativeTypescript = () => {
    const sandbox = this.sandbox;
    const template = getTemplate(sandbox.template);
    return template.isTypescript;
  };

  fetchedSchemas = {};
  getConfigSchemas = async () => {
    const sandbox = this.sandbox;
    const template = getTemplate(sandbox.template);

    const configurations = template.configurationFiles;
    // $FlowIssue
    const schemas: Array<{
      fileName: string,
      schema: Object,
      uri: string,
    }> = (await Promise.all(
      Object.keys(configurations).map(async p => {
        const config = configurations[p];

        if (this.fetchedSchemas[config.title]) {
          return null;
        }

        if (config.schema) {
          try {
            const schema = await fetch(config.schema).then(x => x.json());
            return { fileName: config.title, schema, uri: config.schema };
          } catch (e) {
            return null;
          }
        }
        return null;
      })
    )).filter(x => x);

    const monacoSchemas = schemas.map(data => {
      this.fetchedSchemas[data.fileName] = true;

      return {
        uri: data.uri,
        fileMatch: [data.fileName],
        schema: data.schema,
      };
    });

    this.monaco.languages.json.jsonDefaults.setDiagnosticsOptions({
      validate: true,
      schemas: [
        ...this.monaco.languages.json.jsonDefaults._diagnosticsOptions,
        ...monacoSchemas,
      ],
    });
  };

  closeFuzzySearch = () => {
    this.setState({ fuzzySearchEnabled: false }, () => this.forceUpdate());
    this.editor.focus();
  };

  fetchDependencyTypings = (dependencies: Object) => {
    if (this.typingsFetcherWorker) {
      this.monaco.languages.typescript.typescriptDefaults.setDiagnosticsOptions(
        {
          noSemanticValidation: true,
          noSyntaxValidation: !this.hasNativeTypescript(),
        }
      );
      this.typingsFetcherWorker.postMessage({ dependencies });
    }
  };

  disposeModules = (modules: Array<Module>) => {
    if (this.editor) {
      this.editor.setModel(null);
    }

    if (this.monaco) {
      modules.forEach(m => {
        this.disposeModel(m.id);
      });
    }

    modelCache = {};
  };

  initializeModules = (modules: Array<Module>) =>
    Promise.all(modules.map(module => this.createModel(module, modules)));

  resizeEditor = () => {
    this.forceUpdate(() => {
      this.editor.layout();
    });
  };

  addLib = (code: string, path: string) => {
    const fullPath = `file://${path}`;

    const existingLib = this.monaco.languages.typescript.typescriptDefaults.getExtraLibs()[
      fullPath
    ];
    // Only add it if it has been added before, we don't care about the contents
    // of the libs, only if they've been added.

    if (!existingLib) {
      // We add it manually, and commit the changes manually
      // eslint-disable-next-line no-underscore-dangle
      this.monaco.languages.typescript.typescriptDefaults._extraLibs[
        fullPath
      ] = code;
      this.commitLibChanges();
    }
  };

  /**
   * We manually commit lib changes, because if do this for *every* change we will
   * reload the whole TS worker & AST for every change. This method is debounced
   * by 300ms.
   */
  commitLibChanges = () => {
    // eslint-disable-next-line no-underscore-dangle
    this.monaco.languages.typescript.typescriptDefaults._onDidChange.fire(
      this.monaco.languages.typescript.typescriptDefaults
    );

    this.monaco.languages.typescript.typescriptDefaults.setDiagnosticsOptions({
      noSemanticValidation: false,
      noSyntaxValidation: !this.hasNativeTypescript(),
    });
  };

  createModel = async (
    module: Module,
    modules: Array<Module> = this.sandbox.modules,
    directories: Array<Directory> = this.sandbox.directories
  ) => {
    // Remove the first slash, as this will otherwise create errors in monaco
    const path = getModulePath(modules, directories, module.id);
    if (path) {
      // We need to add this as a lib specifically to Monaco, because Monaco
      // tends to lose type definitions if you don't touch a file for a while.
      // Related issue: https://github.com/Microsoft/monaco-editor/issues/461
      const lib = this.addLib(module.code || '', path);

      const mode = await getMode(module.title, this.monaco);

      const model = this.monaco.editor.createModel(
        module.code || '',
        mode === 'javascript' ? 'typescript' : mode,
        new this.monaco.Uri().with({ path, scheme: 'file' })
      );

      model.updateOptions({ tabSize: this.props.settings.tabWidth });

      modelCache[module.id] = modelCache[module.id] || {
        model: null,
        decorations: [],
        cursorPos: null,
      };
      modelCache[module.id].model = model;
      modelCache[module.id].lib = lib;

      return model;
    }

    return undefined;
  };

  getModelById = async (id: string) => {
    const modules = this.sandbox.modules;

    if (!modelCache[id] || !modelCache[id].model) {
      const module = modules.find(m => m.id === id);

      if (module) {
        await this.createModel(module);
      }
    }

    return modelCache[id];
  };

  openNewModel = async (id: string, title: string) => {
    const modelInfo = await this.getModelById(id);
    this.editor.setModel(modelInfo.model);

    requestAnimationFrame(() => {
      if (modelInfo.cursorPos) {
        this.editor.setPosition(modelInfo.cursorPos);
        this.editor.revealPosition(modelInfo.cursorPos);
      }

      this.syntaxHighlight(
        modelInfo.model.getValue(),
        title,
        modelInfo.model.getVersionId()
      );
      this.lint(
        modelInfo.model.getValue(),
        title,
        modelInfo.model.getVersionId()
      );
    });
  };

  setCurrentModule = (moduleId: string) => {
    this.closeFuzzySearch();

    const module = this.sandbox.modules.find(m => m.id === moduleId);
    if (module) {
      this.changeModule(module);
      if (this.props.onModuleChange) {
        this.props.onModuleChange(moduleId);
      }
    }
  };

  openReference = (data: {
    resource: { path: string },
    options: {
      selection: {
        startLineNumber: number,
        endLineNumber: number,
        startColumn: number,
        endColumn: number,
      },
    },
  }) => {
    const foundModuleId = Object.keys(modelCache).find(
      mId => modelCache[mId].model.uri.path === data.resource.path
    );

    if (foundModuleId) {
      this.setCurrentModule(foundModuleId);
    }

    const selection = data.options.selection;
    if (selection) {
      if (
        typeof selection.endLineNumber === 'number' &&
        typeof selection.endColumn === 'number'
      ) {
        this.editor.setSelection(selection);
        this.editor.revealRangeInCenter(selection);
      } else {
        const pos = {
          lineNumber: selection.startLineNumber,
          column: selection.startColumn,
        };
        this.editor.setPosition(pos);
        this.editor.revealPositionInCenter(pos);
      }
    }

    return Promise.resolve(this.editor);
  };

  getCode = () => this.editor.getValue();

  handleSaveCode = async () => {
    const onSave = this.props.onSave;
    if (onSave) {
      onSave(this.getCode() || '');
    }
  };

  getEditorOptions = () => {
    const settings = this.settings;
    const currentModule = this.currentModule;

    return {
      ...getSettings(settings),
      ariaLabel: currentModule.title,
      readOnly: !!this.props.readOnly,
    };
  };

  render() {
    const { hideNavigation } = this.props;

    const sandbox = this.sandbox;
    const currentModule = this.currentModule;
    const options = this.getEditorOptions();

    return (
      <Container>
        <CodeContainer hideNavigation={hideNavigation}>
          {this.state.fuzzySearchEnabled && (
            <FuzzySearch
              closeFuzzySearch={this.closeFuzzySearch}
              setCurrentModule={this.setCurrentModule}
              modules={sandbox.modules}
              directories={sandbox.directories}
              currentModuleId={currentModule.id}
            />
          )}
          <MonacoEditorComponent
            width="100%"
            height="100%"
            theme="CodeSandbox"
            options={options}
            editorDidMount={this.configureEditor}
            editorWillMount={defineTheme}
            openReference={this.openReference}
          />
        </CodeContainer>
      </Container>
    );
  }
}

export default MonacoEditor;
