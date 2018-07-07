import React from 'react';
import { inject, observer } from 'mobx-react';
import Modal from 'app/components/Modal';
import NewSandbox from 'app/components/NewSandbox';

import PreferencesModal from './PreferencesModal';
import DeleteSandboxModal from './DeleteSandboxModal';
import ShareModal from './ShareModal';
import DeploymentModal from './DeploymentModal';
import ExportGitHubModal from './ExportGitHubModal';
import CommitModal from './CommitModal';
import PRModal from './PRModal';
import SelectSandboxModal from './SelectSandboxModal';
import SearchDependenciesModal from './SearchDependenciesModal';
import DeleteProfileSandboxModal from './DeleteProfileSandboxModal';
import LiveSessionEndedModal from './LiveSessionEndedModal';
import LiveSessionVersionMismatch from './LiveSessionVersionMismatch';
import UploadModal from './UploadModal';
import StorageManagementModal from './StorageManagementModal';
import DashboardChangelog from './Changelog/Dashboard';

const modals = {
  preferences: {
    Component: PreferencesModal,
    width: 900,
  },
  newSandbox: {
    Component: NewSandbox,
    width: 900,
  },
  share: {
    Component: ShareModal,
    width: 900,
  },
  deployment: {
    Component: DeploymentModal,
    width: 750,
  },
  exportGithub: {
    Component: ExportGitHubModal,
    width: 400,
  },
  commit: {
    Component: CommitModal,
    width: 400,
  },
  pr: {
    Component: PRModal,
    width: 400,
  },
  deleteSandbox: {
    Component: DeleteSandboxModal,
    width: 400,
  },
  deleteProfileSandbox: {
    Component: DeleteProfileSandboxModal,
    width: 400,
  },
  selectSandbox: {
    Component: SelectSandboxModal,
    width: 600,
  },
  searchDependencies: {
    Component: SearchDependenciesModal,
    width: 600,
  },
  liveSessionEnded: {
    Component: LiveSessionEndedModal,
    width: 600,
  },
  liveVersionMismatch: {
    Component: LiveSessionVersionMismatch,
    width: 600,
  },
  uploading: {
    Component: UploadModal,
    width: 600,
  },
  storageManagement: {
    Component: StorageManagementModal,
    width: 800,
  },
  changelogDashboard: {
    Component: DashboardChangelog,
    width: 500,
  },
};

function Modals({ store, signals }) {
  const modal = store.currentModal && modals[store.currentModal];

  return (
    <Modal
      isOpen={Boolean(modal)}
      width={modal && modal.width}
      onClose={(isKeyDown: boolean) => signals.modalClosed({ isKeyDown })}
    >
      {modal ? React.createElement(modal.Component) : null}
    </Modal>
  );
}

export default inject('store', 'signals')(observer(Modals));
