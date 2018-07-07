// @flow

import * as React from 'react';
import { sortBy } from 'lodash-es';

import type { Module, Directory } from 'common/types';

import { isMainModule } from 'common/sandbox/modules';
import getType from 'app/utils/get-type';

import File from '../File';

import { Container } from './elements';

type Props = {
  modules: Array<Module>,
  directories: Array<Directory>,
  directoryId: ?string,
  depth?: number,
  currentModule: string,
  setCurrentModule: (id: string) => void,
  template: string,
  entry: string,
};

function Files({
  modules,
  directories,
  directoryId,
  depth = 0,
  currentModule,
  setCurrentModule,
  template,
  entry,
}: Props) {
  const childrenModules = modules.filter(
    m => m.directoryShortid === directoryId
  );

  const childrenDirectories = directories.filter(
    d => d.directoryShortid === directoryId
  );

  return (
    <Container>
      {sortBy(childrenDirectories, d => d.title).map(d => (
        <div key={d.shortid}>
          <File
            id={d.id}
            shortid={d.shortid}
            title={d.title}
            type="directory-open"
            depth={depth}
            setCurrentModule={setCurrentModule}
          />
          <Files
            modules={modules}
            directories={directories}
            directoryId={d.shortid}
            depth={depth + 1}
            setCurrentModule={setCurrentModule}
            currentModule={currentModule}
            template={template}
            entry={entry}
          />
        </div>
      ))}
      {sortBy(childrenModules, m => m.title).map(m => (
        <File
          id={m.id}
          shortid={m.shortid}
          title={m.title}
          key={m.shortid}
          type={getType(m.title)}
          depth={depth}
          setCurrentModule={setCurrentModule}
          active={m.id === currentModule}
          alternative={isMainModule(m, modules, directories, entry)}
        />
      ))}
    </Container>
  );
}

export default Files;
