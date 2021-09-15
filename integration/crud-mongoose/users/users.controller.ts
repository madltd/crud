import { Controller } from '@nestjs/common';
import { Crud, CrudController } from '@mfcdev/crud';
import { User } from './user.entity';
import { UsersService } from './users.service';

@Crud({
  model: {
    type: User,
  },
  params: {
    id: {
        field: 'id',
        type: 'string',
        primary: true
    }
},
  query: {
    limit: 10,
    maxLimit: 100,
    alwaysPaginate: true
  }
})
@Controller('users')
export class UsersController implements CrudController<User> {

  constructor(public service: UsersService) {
  }
}
