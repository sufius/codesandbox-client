import styled, { css } from 'styled-components';

export const Container = styled.div`
  transition: 0.3s ease all;
  display: inline-block;
  padding: 1rem;
  color: white;

  width: ${props => props.width}px;
  border: 2px solid rgba(0, 0, 0, 0.3);
  background-color: rgba(0, 0, 0, 0.2);
  border-radius: 4px;
  display: flex;
  align-items: center;
  margin-bottom: 1rem;
  margin-right: 1rem;
  cursor: pointer;

  &:last-child {
    margin-right: 0;
  }

  outline: none;

  ${props =>
    props.selected
      ? css`
          color: white;
          background-color: ${props.color.clearer(0.3)};
          border-color: rgba(255, 255, 255, 0.2);
        `
      : css`
          &:hover,
          &:focus {
            background-color: ${props.color.clearer(0.6)};
            border-color: rgba(255, 255, 255, 0.1);
          }
        `};
`;

export const Title = styled.div`
  transition: 0.3s ease color;
  font-size: 1.125rem;
  color: ${props => (props.selected ? 'white' : props.color)};
  margin-bottom: 0.25rem;
  font-weight: 600;
`;

export const SubTitle = styled.div`
  font-size: 0.875rem;

  color: ${props =>
    props.selected ? 'rgba(255, 255, 255, 0.6)' : 'rgba(255, 255, 255, 0.4)'};
`;

export const IconContainer = styled.div`
  margin-left: 0.5rem;
  align-items: center;
`;
