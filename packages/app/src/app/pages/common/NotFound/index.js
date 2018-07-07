import React from 'react';

import { inject } from 'mobx-react';
import SubTitle from 'app/components/SubTitle';
import Button from 'app/components/Button';
import { newSandboxWizard } from 'common/utils/url-generator';

import { Container, Title, Buttons } from './elements';

function NotFound({ store }) {
  const { hasLogIn } = store;

  return (
    <Container>
      <Title>404</Title>
      <SubTitle>We could not find the page you{"'"}re looking for :(</SubTitle>
      <Buttons>
        <Button small block style={{ margin: '.5rem' }} to={newSandboxWizard()}>
          Create Sandbox
        </Button>
        <Button small block style={{ margin: '.5rem' }} href="/">
          To {hasLogIn ? 'Dashboard' : 'Homepage'}
        </Button>
      </Buttons>
    </Container>
  );
}

export default inject('store')(NotFound);
