// @flow
import React from 'react';

import type { Editor, Settings } from '../types';
import MonacoReactComponent from '../Monaco/MonacoReactComponent';
import defineTheme from '../Monaco/define-theme';

import { Container, CodeContainer } from '../Monaco/elements';
import getSettings from '../Monaco/settings';
import getMode from '../Monaco/mode';

type Props = {
  originalCode: string,
  modifiedCode: string,
  title?: string,
  settings: Settings,
};

export default class MonacoDiff extends React.Component<Props>
  implements Editor {
  editor: any;
  monaco: any;
  sizeProbeInterval: IntervalID; // eslint-disable-line no-undef

  settings: Settings;

  constructor(props: Props) {
    super(props);

    this.settings = props.settings;
  }

  componentWillUpdate(nextProps: Props) {
    if (
      this.props.originalCode !== nextProps.originalCode ||
      this.props.modifiedCode !== nextProps.modifiedCode
    ) {
      this.setDiff(
        nextProps.originalCode,
        nextProps.modifiedCode,
        nextProps.title
      );
    }
  }

  componentWillUnmount() {
    window.removeEventListener('resize', this.resizeEditor);
    clearInterval(this.sizeProbeInterval);
  }

  resizeEditor = () => {
    this.forceUpdate(() => {
      this.editor.layout();
    });
  };

  setDiff = async (
    originalCode: string,
    modifiedCode: string,
    title: string
  ) => {
    const mode = await getMode(title, this.monaco);
    const originalModel = this.monaco.editor.createModel(originalCode, mode);
    const modifiedModel = this.monaco.editor.createModel(modifiedCode, mode);

    this.editor.setModel({
      original: originalModel,
      modified: modifiedModel,
    });
  };

  configureEditor = async (editor: any, monaco: any) => {
    this.editor = editor;
    this.monaco = monaco;

    await this.setDiff(
      this.props.originalCode,
      this.props.modifiedCode,
      this.props.title || ''
    );

    window.addEventListener('resize', this.resizeEditor);

    this.resizeEditor();
    this.sizeProbeInterval = setInterval(this.resizeEditor.bind(this), 3000);
  };

  render() {
    return (
      <Container>
        <CodeContainer>
          <MonacoReactComponent
            diffEditor
            theme="CodeSandbox"
            editorWillMount={defineTheme}
            editorDidMount={this.configureEditor}
            options={getSettings(this.settings)}
          />
        </CodeContainer>
      </Container>
    );
  }
}
