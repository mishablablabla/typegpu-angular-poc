import { ApplicationConfig, provideBrowserGlobalErrorListeners } from '@angular/core';

// No TypeGPU provider needed: `TypeGpu` is providedIn 'root'. Use provideTypeGpu({...}) to configure.
export const appConfig: ApplicationConfig = {
  providers: [provideBrowserGlobalErrorListeners()],
};
